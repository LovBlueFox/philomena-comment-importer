import {readFileSync, writeFileSync} from "node:fs";
import {parse} from "csv-parse/sync";
import postgres from "pg";
import dotenv from "dotenv";
import {Client} from '@opensearch-project/opensearch';

dotenv.config();

let usersDB = {};
let imagesDB = {};
let importUsers = {};
let importComments = [];
let processingLog = "";
let scriptStartTime = Date.now();

const database = new postgres.Client({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_DATABASE,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

let openSearchClient;

async function start() {
    database.connect()
        .then(() => console.log("Import database connected"))
        .catch(error => {
            console.error("Destination database connection error\n", error);
            process.exit(1);
        });

    await testTable(process.env.DB_TABLE_IMAGES);
    await testTable(process.env.DB_TABLE_COMMENTS);
    await testTable(process.env.DB_TABLE_USERS);

    imagesDB = await database.query(`SELECT id, description
                                     FROM ${process.env.DB_TABLE_IMAGES}`);
    usersDB = await database.query(`SELECT id, name
                                    FROM ${process.env.DB_TABLE_USERS}`);

    console.log('----------------------------------------');

    try {
        openSearchClient = new Client({
            node: process.env.OPENSEARCH_NODE
        });
        await openSearchClient.info();
        console.log('Connected to OpenSearch');
    } catch (error) {
        console.error('Error connecting to OpenSearch:', error);
        process.exit(1);
    }

    await testIndex(process.env.OPENSEARCH_INDEX_COMMENT);

    console.log('----------------------------------------');

    let comment_structure = [
        {
            type: 'integer', csv_column: 'id', db_column: 'id', CALLBACK: (record, id) => {
                record.old_id = id;
                return [record, id];
            }
        },
        {type: 'varchar',   csv_column: null,           db_column: 'body_textile',      DEFAULT: ""},
        {type: 'inet',      csv_column: null,           db_column: 'ip',                DEFAULT: null},
        {type: 'varchar',   csv_column: null,           db_column: 'fingerprint',       DEFAULT: null},
        {type: 'varchar',   csv_column: null,           db_column: 'user_agent',        DEFAULT: ""},
        {type: 'varchar',   csv_column: null,           db_column: 'referrer',          DEFAULT: ""},
        {type: 'boolean',   csv_column: null,           db_column: 'anonymous',         DEFAULT: false},
        {type: 'boolean',   csv_column: null,           db_column: 'hidden_from_users', DEFAULT: false},
        {type: 'integer',   csv_column: 'user_id',      db_column: 'user_id',           CALLBACK: processUserId},
        {type: 'integer',   csv_column: null,           db_column: 'deleted_by_id',     DEFAULT: null},
        {type: 'integer',   csv_column: 'image_id',     db_column: 'image_id',          CALLBACK: processImageId},
        {type: 'timestamp', csv_column: 'created_at',   db_column: 'created_at'},
        {type: 'timestamp', csv_column: 'updated_at',   db_column: 'updated_at'},
        {type: 'varchar',   csv_column: null,           db_column: 'edit_reason',       DEFAULT: null},
        {type: 'timestamp', csv_column: null,           db_column: 'edited_at',         DEFAULT: null},
        {type: 'varchar',   csv_column: null,           db_column: 'deletion_reason',   DEFAULT: ""},
        {type: 'boolean',   csv_column: null,           db_column: 'destroyed_content', DEFAULT: false},
        {type: 'varchar',   csv_column: null,           db_column: 'name_at_post_time', DEFAULT: null},
        {type: 'string',    csv_column: 'body',         db_column: 'body',              CALLBACK: processBody},
        {type: 'boolean',   csv_column: null,           db_column: 'approved',          DEFAULT: true},
    ];

    importComments = await csv2json(process.env.CSV_COMMENTS, comment_structure.reduce((acc, heading) => {
        if (heading.csv_column)
            acc[heading.csv_column] = heading.type;
        return acc;
    }, {}));

    importComments.sort((a, b) => a.id - b.id);

    importUsers = await csv2json(process.env.CSV_USERS, {
        id: "integer",
        name: "varchar"
    }).then(users => {
        return users.reduce((acc, user) => {
            acc[user.id] = user.name;
            return acc;
        }, {});
    });

    console.log('----------------------------------------');
    console.log(`Mapping CSV columns to DB '${process.env.DB_TABLE_COMMENTS}' table columns`);

    importComments = await Promise.all(importComments.map(async comment => {
        for (const heading of comment_structure) {
            comment[heading.db_column] = comment[heading.db_column] ?? heading.DEFAULT ?? comment[heading.csv_column];
        }
        return comment;
    }));

    if (process.env.PHILOMENA_IMPORT === 'false') {
        console.log("!!! Importing comments is currently disabled. To enable importing, set 'PHILOMENA_IMPORT=true' in the .env file.");
        await delay(5000);
    }

    await (async () => {
        let processedComments = [];
        let batchSize = 250;
        let startTime = Date.now();

        for (let i = 0; i < importComments.length; i += batchSize) {
            const batch = importComments.slice(i, i + batchSize);
            const processingStart = Date.now();

            console.clear();
            console.oldLog('----------------------------------------');
            console.oldLog('Processing Comments: (NOT IMPORTING YET)');
            console.oldLog(`COMMENT:`, i, `of`, Math.ceil(importComments.length));
            console.oldLog(`Execution Time:`, formatTime(processingStart - startTime));
            console.oldLog(`Estimated Time Remaining:`, formatTime((processingStart - startTime) / i * (importComments.length - i)));
            console.oldLog(`Items Per Second:`, Math.floor(i / (processingStart - startTime) * 1000));
            console.oldLog('----------------------------------------');

            const processedBatch = await Promise.all(batch.map(async comment => {
                for (const heading of comment_structure) {
                    if (heading.CALLBACK && comment[heading.db_column] !== undefined) {
                        // noinspection ES6RedundantAwait
                        [comment, comment[heading.db_column]] = await heading.CALLBACK(comment, comment[heading.db_column]);
                    }
                }
                return comment;
            }));

            processedComments.push(...processedBatch);
        }
        // process.exit(1)

        console.clear();
        console.log('----------------------------------------');
        console.log(`Processing Comments - Complete`);
        console.log(`Total Processing Time:`, formatTime(Date.now() - startTime));
        console.log(`Total Comments Processed:`, importComments.length);
        console.log('----------------------------------------');

        if (process.env.PHILOMENA_IMPORT !== 'false') {
            for (let i = 2; i > 0; i--) {
                console.clear();
                console.oldLog('----------------------------------------');
                console.oldLog('Starting Import in:', i);
                console.oldLog('----------------------------------------');
                await delay(1000);
            }
            await importData(processedComments);
        } else {
            console.log('Importing comments is currently disabled; will not continue with importing process.');
            console.log('First comment example:', JSON.stringify(processedComments[0], null, 2));
        }
    })();
}

start()
    .then(() => {
        console.clear();
        console.oldLog(processingLog);
        writeFileSync("processing.log", processingLog);
    })
    .catch(error => {
        console.error("An error occurred during the comment processing:", error);
    })
    .finally(() => {
        database.end()
            .then(() => console.log(`Finished & Database connection closed. Finished in`, formatTime(Date.now() - scriptStartTime)))
            .catch(error => console.error("Error closing the database connection:", error));
    });

/* CALLBACKS */

async function processUserId(record, user_id) {
    const user = usersDB.rows.find(user => user.name === importUsers[user_id]);
    record.old_user_id = user_id;
    record.ip = `127.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    record.fingerprint = Math.floor(Math.random() * 1000000);
    if (user_id === 'NULL') {
        record.anonymous = true;
        user_id = null;
    } else {
        let [part1, part2, part3] = user_id.toString().padStart(3, '0').split('').map(num => parseInt(num) % 255);
        record.ip = `127.${part1}.${part2}.${part3}`;
        record.fingerprint = user_id;
    }

    if (!user) {
        if (process.env.PHILOMENA_ANONYMOUS !== 'false') {
            record.anonymous = true;
        }
        if (record.anonymous) {
            user_id = null;
        } else {
            user_id = parseInt(process.env.PHILOMENA_IMPORTER_USER_ID);
        }
    } else {
        user_id = user.id;
        record.anonymous = false;
    }

    return [record, user_id];
}

function getUserName(user_id) {
    const user = usersDB.rows.find(user => user.name === importUsers[user_id]);
    let anonymous = false;
    if (!user) {
        if (process.env.PHILOMENA_ANONYMOUS !== 'false') {
            anonymous = true;
        }
        if (anonymous) {
            return 'Anonymous';
        } else {
            return 'Importer';
        }
    }
    return user.name;
}

async function processImageId(record, image_id) {
    try {
        record.old_image_id = image_id;
        const result = imagesDB.rows.find(image => image.description.includes(`Original: https://derpibooru.org/images/${image_id}`));
        image_id = result ? result.id : null;
    } catch (error) {
        console.log('Error processing image_id', image_id, 'will skip on import:');
        console.log(error);
        image_id = null;
    }

    return [record, image_id];
}

function processBody(record, body) {
    let suffix = !importUsers[record.old_user_id]
        ? process.env.PHILOMENA_SUFFIX_DETAILS_NOT_EXIST
        : process.env.PHILOMENA_SUFFIX_DETAILS;

    suffix = suffix.replace(/\${(user|record)\.(.*?)}/g, (match, p1, p2) => {
        if (p1 === 'user' && p2 === 'name') {
            return importUsers[record.old_user_id] ?? 'N/A';
        }
        if (p1 === 'record') {
            return record[p2] ?? '';
        }
        return '';
    });

    body = body.replace(new RegExp(`${record.old_image_id}`, 'g'), `${record.image_id}`);

    return [record, body + suffix];
}

/* FUNCTIONS */

async function importData(comments) {
    console.clear();

    let imageArray = [];
    let importIdMap = {};
    if (process.env.PHILOMENA_IMPORT_ID_MAP) {
        importIdMap = JSON.parse(readFileSync(process.env.PHILOMENA_IMPORT_ID_MAP, 'utf8'));
    }

    const batchSize = parseInt(process.env.PHILOMENA_IMPORT_BATCH_LIMIT);


    let insertBatches = [];
    let updateBatches = [];

    let insertBatch = [];
    let updateBatch = [];

    console.log('Starting Database Import');
    let lastId = await database.query(`SELECT id
                                       FROM ${process.env.DB_TABLE_COMMENTS}
                                       ORDER BY id DESC LIMIT 1`);
    lastId = lastId.rows[0]?.id ?? 0;

    console.log('Last ID:', lastId);

    await database.query(`ALTER SEQUENCE ${process.env.DB_TABLE_COMMENTS}_id_seq RESTART WITH ${lastId + comments.length + 1}`);

    for (const comment of comments) {
        try {
            console.clear();
            console.oldLog('----------------------------------------');
            console.oldLog('Processing Comment:', comment.id);

            if (insertBatch.length >= batchSize) {
                insertBatches.push(insertBatch);
                insertBatch = [];
            }

            if (updateBatch.length >= batchSize) {
                updateBatches.push(updateBatch);
                updateBatch = [];
            }

            if (!comment.image_id) {
                console.log(' - SKIPPING COMMENT ID:', comment.id, 'HAS NO IMAGE ID');
            } else {
                if (comment.image_id) imageArray.push(comment.image_id);
                const existingCommentId = importIdMap[comment.id];
                if (existingCommentId) {
                    if (process.env.PHILOMENA_IMPORT_REPLACE === 'false') {
                        console.log(' - SKIPPING COMMENT ID:', existingCommentId, 'REPLACE DISABLED');
                    } else {
                        console.log(' - UPDATING COMMENT ID:', existingCommentId);
                        comment.id = existingCommentId;
                        updateBatch.push(comment);
                    }
                } else {
                    lastId++;
                    importIdMap[comment.id] = lastId;
                    comment.id = lastId;
                    console.log(' - INSERTING COMMENT ID:', comment.id);
                    insertBatch.push(comment);
                }
            }

            if (comment.body.includes('comment_')) {
                const reference_id = comment.body.match(/comment_(\d+)/)[1];
                const commentRef = comments.find(comment => comment.old_id === parseInt(reference_id));
                comment.body = comment.body.replace(`comment_${reference_id}`, `comment_${commentRef.id}`);
            }
        } catch (error) {
            console.log('Error processing comment:', error);
        }
    }

    insertBatches.push(insertBatch);
    updateBatches.push(updateBatch);

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalInsertItems = insertBatches.length * batchSize;
    let totalUpdateItems = updateBatches.length * batchSize;

    let startTime = Date.now();
    for (const batch of insertBatches) {
        if (batch.length === 0) continue;
        const processingStart = Date.now();
        console.clear();
        console.oldLog('----------------------------------------');
        console.oldLog('Processing Insert Batch');
        console.oldLog(`Batch Size:`, batch.length);
        console.oldLog(`Total Inserted Batches:`, totalInserted);
        console.oldLog(`Execution Time:`, formatTime(processingStart - startTime));
        const estimatedTimeRemaining = totalInserted > 0
            ? formatTime((processingStart - startTime) / totalInserted * (totalInsertItems - totalInserted))
            : '00:00';
        console.oldLog(`Estimated Time Remaining:`, estimatedTimeRemaining);
        console.oldLog(`Items Per Second:`, Math.floor(totalInserted / (processingStart - startTime) * 1000));
        console.oldLog('----------------------------------------');
        totalInserted += batch.length;
        console.log('BATCH INSERT:', totalInserted);
        await batchInsert('comments', batch);
        console.log('----------------------------------------');
    }

    for (const batch of updateBatches) {
        if (!batch || batch.length === 0) continue;
        const processingStart = Date.now();
        console.clear();
        console.oldLog('----------------------------------------');
        console.oldLog('Processing Update Batch');
        console.oldLog(`Batch Size:`, batch.length);
        console.oldLog(`Total Updated Batches:`, totalUpdated);
        console.oldLog(`Execution Time:`, formatTime(processingStart - startTime));
        const estimatedTimeRemaining = totalUpdated > 0
            ? formatTime((processingStart - startTime) / totalUpdated * (totalUpdateItems - totalUpdated))
            : '00:00';
        console.oldLog(`Estimated Time Remaining:`, estimatedTimeRemaining);
        console.oldLog(`Items Per Second:`, Math.floor(totalUpdated / (processingStart - startTime) * 1000));
        console.oldLog('----------------------------------------');
        totalUpdated += batch.length;
        console.log('BATCH UPDATE:', totalUpdated);
        await batchUpdate('comments', batch);
        console.log('----------------------------------------');
    }

    // Save the importIdMap to a file
    if (process.env.PHILOMENA_IMPORT_ID_MAP) {
        try {
            await writeFileSync(process.env.PHILOMENA_IMPORT_ID_MAP, JSON.stringify(importIdMap, null, 2));
            console.log('Saved import ID map to', process.env.PHILOMENA_IMPORT_ID_MAP);
        } catch (error) {
            console.error('Error saving import ID map:', error);
        }
    }

    //store user_id's for statistics
    console.log('Adjusting user statistics');

    console.log('Adjusting image comments count...');
    let totalProcessed = 0;
    let imageBatch = [];
    startTime = Date.now();
    for (const image_id of imageArray) {
        const processingStart = Date.now();
        console.clear();
        console.oldLog('----------------------------------------');
        console.oldLog('Adjusting Image Comments Count');
        console.oldLog(`Image ID:`, image_id);
        console.oldLog(`Total Processed:`, totalProcessed);
        console.oldLog(`Execution Time:`, formatTime(processingStart - startTime));
        console.oldLog(`Estimated Time Remaining:`, formatTime((processingStart - startTime) / totalProcessed * (imageArray.length - totalProcessed)));
        console.oldLog(`Items Per Second:`, Math.floor(totalProcessed / (processingStart - startTime) * 1000));
        console.oldLog('----------------------------------------');

        const totalComments = await database.query(`SELECT COUNT(*)
                                                    FROM ${process.env.DB_TABLE_COMMENTS}
                                                    WHERE image_id = $1`, [image_id]);
        imageBatch.push({
            image_id: image_id,
            comments_count: totalComments.rows[0].count ?? 0
        });

        if (imageBatch.length >= batchSize) {
            await executeBatchUpdate(imageBatch);
            imageBatch = [];
        }

        totalProcessed++;
    }

    // Execute any remaining updates in the batch
    if (imageBatch.length > 0) {
        await executeBatchUpdate(imageBatch);
    }
}

async function executeBatchUpdate(batch) {
    const query = `UPDATE ${process.env.DB_TABLE_IMAGES} AS img
                   SET comments_count = updates.comments_count::integer
                   FROM (VALUES ${batch.map((_, i) => `($${i * 2 + 1}::integer, $${i * 2 + 2}::integer)`).join(', ')}) AS updates(image_id, comments_count)
                   WHERE img.id = updates.image_id`;

    const values = batch.flatMap(item => [item.image_id, item.comments_count]);
    await database.query(query, values);
}

async function batchInsert(table, data) {
    try {
        let columns = Object.keys(data[0]).filter(column => !column.startsWith('old_'));
        let query = `INSERT INTO ${table} (${columns.join(', ')})
                     VALUES ${data.map((_, i) => `(${columns.map((_, j) => `$${i * columns.length + j + 1}`).join(', ')})`).join(', ')}`;
        let values = data.flatMap(item => columns.map(column => item[column]));
        await database.query(query, values);
        console.log(`Batch Inserted ${data.length} records into ${table}`);

        openSearchClient.bulk({
            index: process.env.OPENSEARCH_INDEX_COMMENT,
            body: data.flatMap(item => [
                {index: {_index: 'comments', _id: item.id}},
                {
                    ip: item.ip,
                    author: getUserName(item.user_id) ?? 'Anonymous',
                    approved: item.approved,
                    body: item.body,
                    image_id: item.image_id,
                    fingerprint: item.fingerprint,
                    user_id: item.user_id,
                    hidden_from_users: item.hidden_from_users,
                    anonymous: item.anonymous,
                    image_tag_ids: item.image_tag_ids || [],
                    posted_at: new Date(item.created_at).toISOString()
                }
            ])
        });
    } catch (e) {
        console.error(`Error inserting into ${table}:`, e.message, e.stack);
    }
}

async function batchUpdate(table, data) {
    try {
        let columns = Object.keys(data[0]).filter(column => !column.startsWith('old_'));
        let query = `UPDATE ${table}
                     SET ${columns.map((column, i) => `${column} = $${i + 1}`).join(', ')}
                     WHERE id = $${columns.length + 1}`;

        console.log(` - BATCH UPDATE: ${data.map(item => item.id).join(', ')}`);

        for (const item of data) {
            let values = columns.map(column => item[column]);
            values.push(item.id);
            await database.query(query, values);
            await updateOrCreateDocument(item);
        }
    } catch (e) {
        console.error(`Error updating ${table}:`, e);
    }
}

async function updateOrCreateDocument(item) {
    const postedAtISO = new Date(item.created_at).toISOString();
    let document = {
        ip: item.ip,
        author: getUserName(item.user_id) ?? 'Anonymous',
        approved: item.approved,
        body: item.body,
        image_id: item.image_id,
        fingerprint: item.fingerprint,
        user_id: item.user_id,
        hidden_from_users: item.hidden_from_users,
        anonymous: item.anonymous,
        image_tag_ids: item.image_tag_ids || [],
        posted_at: postedAtISO
    };
    try {
        await openSearchClient.update({
            index: process.env.OPENSEARCH_INDEX_COMMENT,
            id: item.id,
            body: {
                doc: document
            }
        });
    } catch (error) {
        if (error.meta.body.error.type === 'document_missing_exception') {
            await openSearchClient.index({
                index: process.env.OPENSEARCH_INDEX_COMMENT,
                id: item.id,
                body: document
            });
        } else {
            throw error;
        }
    }
}

async function delay(ms) {
    for (let i = ms / 1000; i > 0; i--) {
        process.stdout.write(`\rCountdown: ${i} seconds remaining `);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    process.stdout.write('\rCountdown: 0 seconds remaining \n');
}

async function csv2json(file, headings) {
    console.log(`Parsing CSV file: ${file}`);
    try {
        let data = readFileSync(file, 'utf8');
        const lines = data.split('\n');

        // Filter out lines with an odd number of double quotes greater than 3
        const filteredLines = lines.filter(line => {
            const columns = line.split(',');
            let quoteCount = 0;
            for (const column of columns) {
                quoteCount += column.split('"').length - 1;
            }
            if (quoteCount % 2 !== 0) {
                if (!line.endsWith('"') || line.endsWith(',"')) {
                    return true;
                }
                console.log('REMOVED LINE: ', line);
                return false;
            }
            return true;
        });

        data = filteredLines.join('\n');

        return await parseCSV(data, headings);
    } catch (error) {
        console.log('Error filtering CSV data:', error);
        process.exit(1);
    }
}

async function parseCSV(records, headings, tries = {
    attempt: 0,
}) {
    try {
        return parse(records, {
            columns: true,
            skip_empty_lines: true,
            trim: true,
            autoParse: true,
        }).map(record => {
            const json = {};
            for (const key in headings) {
                let value = record[key];
                if (headings[key] === 'integer') {
                    let number = parseInt(value);
                    if (!isNaN(number)) {
                        value = number;
                    }
                }
                if (headings[key] === 'timestamp') {
                    const date = new Date(value);
                    value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
                }
                if (headings[key] === 'boolean') value = value === 'true';
                if (headings[key] === 'inet') value = {address: value};
                if (headings[key] === 'varchar') value = value.toString();
                json[key] = value;
            }

            return json;
        });
    } catch (error) {
        const lineNumberMatch = error.message.match(/at line (\d+)/);
        if (lineNumberMatch) {
            const lineNumber = parseInt(lineNumberMatch[1], 10);
            const lines = records.split('\n');
            if (lineNumber > 0 && lineNumber <= lines.length) {
                console.error(`REMOVED LINE:  ${lines[lineNumber - 1]}`);

                lines.splice(lineNumber - 1, 1);
                records = lines.join('\n');

                if (tries.attempt < 5) {
                    if (tries.lineNumber === lineNumber) {
                        tries.attempt += 1;
                    } else {
                        tries.attempt = 1;
                        tries.lineNumber = lineNumber;
                    }
                    return await parseCSV(records, headings, tries);
                }

                console.error(`Error parsing CSV:`, error);
                process.exit(1);
            }
        }
    }
}

async function testTable(table) {
    try {
        await database.query(`SELECT *
                              FROM ${table}`);
        console.log(`Table '${table}' found in the database.`);
    } catch (error) {
        console.error(`${table} table not found. Ensure the table name matches correctly and update it in the .env file (DB_TABLE_*)`, error);
        process.exit(1);
    }
}

async function testIndex(name) {
    const indexes = await openSearchClient.cat.indices({format: 'json'});
    try {
        const index = indexes.body.find(index => index.index === name);
        if (index) {
            if (index.status !== 'open') {
                console.error(`Index '${name}' is not open. Current status: ${index.status}`);
                console.error('Exiting due to index not being open.');
                process.exit(1);
            }
            if (index.health === 'red') {
                console.error(`Index '${name}' health is red. Current health: ${index.health}`);
                console.error('Exiting due to critical index health status.');
                process.exit(1);
            } else if (index.health === 'yellow') {
                console.warn(`!!WARNING!! Index '${name}' health is YELLOW health. possibly indicating a replica issue. (continue at your own risk - 10 second delay)`);
                await delay(10000);
            } else {
                console.log(`Index '${name}' found in OpenSearch`);
            }
        } else {
            console.error(`Index '${name}' not found. Ensure the index name matches correctly and update it in the .env file (OPENSEARCH_INDEX_*)`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Index '${name}' not found. Ensure the index name matches correctly and update it in the .env file (OPENSEARCH_INDEX_*)`, error);
        process.exit(1);
    }
}

function formatTime(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

console.oldLog = console.log;
console.oldError = console.error;
console.log = function () {
    console.oldLog(...arguments);
    let args = Array.from(arguments).map(arg => {
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return '[Circular]';
            }
        }
        return arg.toString();
    });
    // args.unshift(new Date().toISOString());

    processingLog += args.join(' ') + '\n';
}

console.error = function () {
    console.oldLog(...arguments);
    let args = Array.from(arguments).map(arg => {
        if (typeof arg === 'object') {
            try {
                return JSON.stringify(arg);
            } catch (e) {
                return '[Circular]';
            }
        }
        return arg.toString();
    });
    // args.unshift(new Date().toISOString());

    processingLog += args.join(' ') + '\n';
}

// capture process exit to handle cleanup
process.on('exit', (code) => {
    console.log(`Process exited with code ${code}`);

    database.end();

    openSearchClient.close();

    // save the processing log to a file
    writeFileSync("processing.log", processingLog);
});
