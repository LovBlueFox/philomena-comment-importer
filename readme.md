
# Comment Importer (Derpibooru => Tantabus)

This project is a migration application designed to import comments from a nightly Philomena dump into a PostgreSQL and OpenSearch database.


## Why It Was Needed
This application was created to import comments from Derpibooru to Tantabus, due to the AI-generated images on Derpibooru being wiped on 6th of January 2025. Since all the images have already been imported, this application was developed to import the comments as well, due to somewhat popular demand. The application is capable of looking up users, finding the correct images to attach the comments to, and has the ability to map itself for future changes.


## How To Get The Data
You can use the existing files in the root folder, which contains the already exported CSV data of the users and comments from the Derpibooru public dump as of 31st December 2024.

### [Optional] Getting the data from the Derpibooru public dump
The data can be obtained from the https://derpibooru.org/pages/data_dumps page. The data is updated nightly, and the comments are stored in a pgdump file.

From there you can import the file into a PostgreSQL database using the following command:
```bash
dropdb --if-exists derpibooru
createdb derpibooru
pg_restore -U postgres -O -d derpibooru "derpibooru_public_dump.pgdump"
```

Now you can export the users and comments that match with a specific image tag to a CSV file using the following query in pgAdmin 4:
```postgresql
SELECT id, name FROM public.users;
```
```postgresql
SELECT c.* FROM public.comments c JOIN public.image_taggings it ON c.image_id = it.image_id WHERE it.tag_id = 661924;
```

Make sure to replace `it.tag_id = 661924` with the tag id you want to export the comments for; for example:
 - tag `ai content` is tag id: `661924`
 - tag `ai geneated` is tag id `589483`.

In pgAdmin 4 you can export the data to a CSV file by pressing F8 or clicking the 'save results to file' button.

Once exported, you can use the CSV files to import the comments into the database, place the CSV files in the root of the project and ensure the following .env variables are set:
```dotenv
CSV_USERS='users-export.csv'
CSV_COMMENTS='comments-export.csv'
```

#### Why CSV and not JSON or a direct connection?
Due to not knowing how Derpibooru and Tantabus are hosted or if they can communicate with each other, I've decided to use CSV files as a middleman to ensure the data can be imported. There are methods of exporting as JSON, but they're a bit sketchy. Besides, I've already had a system to import with CSV, so I've decided to use that.

#### Why get the data from the nightly dump, not the database?
Well, for testing, the nightly dump was easier; however, if you prefer to use the database export, you can update the index.js code on line 60 and the csv_column variables.

FYI I did not test whether this would work, and i can already see issues doing this method with how the code matches and changes the body of the comments.
```javascript
    let comment_structure = [
        {
            type: 'integer', csv_column: 'id', db_column: 'id', CALLBACK: (record, id) => {
                record.old_id = id;
                return [record, id];
            }
        },
        {type: 'varchar',   csv_column: 'body_textile',      db_column: 'body_textile',      DEFAULT: ""},
        {type: 'inet',      csv_column: 'ip',                db_column: 'ip',                DEFAULT: null},
        {type: 'varchar',   csv_column: 'fingerprint',       db_column: 'fingerprint',       DEFAULT: null},
        {type: 'varchar',   csv_column: 'user_agent',        db_column: 'user_agent',        DEFAULT: ""},
        {type: 'varchar',   csv_column: 'referrer',          db_column: 'referrer',          DEFAULT: ""},
        {type: 'boolean',   csv_column: 'anonymous',         db_column: 'anonymous',         DEFAULT: false},
        {type: 'boolean',   csv_column: 'hidden_from_users', db_column: 'hidden_from_users', DEFAULT: false},
        {type: 'integer',   csv_column: 'user_id',           db_column: 'user_id',           CALLBACK: processUserId},
        {type: 'integer',   csv_column: 'deleted_by_id',     db_column: 'deleted_by_id',     DEFAULT: null},
        {type: 'integer',   csv_column: 'image_id',          db_column: 'image_id',          CALLBACK: processImageId},
        {type: 'timestamp', csv_column: 'created_at',        db_column: 'created_at'},
        {type: 'timestamp', csv_column: 'updated_at',        db_column: 'updated_at'},
        {type: 'varchar',   csv_column: 'edit_reason',       db_column: 'edit_reason',       DEFAULT: null},
        {type: 'timestamp', csv_column: 'edited_at',         db_column: 'edited_at',         DEFAULT: null},
        {type: 'varchar',   csv_column: 'deletion_reason',   db_column: 'deletion_reason',   DEFAULT: ""},
        {type: 'boolean',   csv_column: 'destroyed_content', db_column: 'destroyed_content', DEFAULT: false},
        {type: 'varchar',   csv_column: 'name_at_post_time', db_column: 'name_at_post_time', DEFAULT: null},
        {type: 'string',    csv_column: 'body',              db_column: 'body',              CALLBACK: processBody},
        {type: 'boolean',   csv_column: 'approved',          db_column: 'approved',          DEFAULT: true},
    ];
```


## Setting up the destination database
The following ports need to be open on the destination location (Tantabus) for the migration application to work, which can be done on the docker file and some direct access to the service:
```yaml
  postgres:
    ports:
      - '5432:5432'
```
Once the ports are open, make sure to update the following environment variables correctly:
```dotenv
DB_HOST=localhost
DB_DATABASE=philomena
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=postgres

DB_TABLE_COMMENTS=comments  # used to import the comments
DB_TABLE_IMAGES=images      # used to match the comments image_id to the image
DB_TABLE_USERS=users        # used to match the comments user_id to the user
```


## Setting up the OpenSearch database
The following ports need to be open on the destination location (tantabus) for the migration application to work, which can be done on the docker file and some direct access to the service:
```yaml
  opensearch:
    ports:
      - '9200:9200'
```

Once the ports are open, make sure to update the following environment variables correctly:
```dotenv
OPENSEARCH_NODE=http://localhost:9200
OPENSEARCH_INDEX_COMMENT=comments   # used to index the new comments for searching and to show up on the user profile (if the user exists)
```

If OpenSearch uses SSL, update the index.js file to include the SSL options on line 45.


## Additional Environment Variables

The following environment variables can be set to change how the user is defined in the comments.
```dotenv
## if true, and the user does not exist, they will be set anonymous otherwise, it will use the IMPORTER user_id
PHILOMENA_ANONYMOUS=true
## If PHILOMENA_ANONYMOUS is false, and the user does not exist, the following user_id will be used instead.
PHILOMENA_IMPORTER_USER_ID=12 # 12 is the tantabus importer user.

# The following adds a suffix to the comment to show where the comment was imported from.
## The following is the default suffix if the user exists.
PHILOMENA_SUFFIX_DETAILS="\n\n---\n~Imported from [Derpibooru](https://derpibooru.org/) - Posted by **${user.name}**~"
## The following is the default suffix if the user does NOT exist.
PHILOMENA_SUFFIX_DETAILS_NOT_EXIST="\n\n---\n~Imported from [Derpibooru](https://derpibooru.org/)~"
```

Here is a preview of the comment with the suffix:
<img src="./doc/Comment Suffix Preview.png">

Finally, the following environment variables can be set to change how the importer works; they shouldn't need to be changed unless you know what you are doing.
```dotenv
PHILOMENA_IMPORT=true # If true, the comments will be imported into the database.
PHILOMENA_IMPORT_BATCH_LIMIT=100 # the number of comments to import at a time
PHILOMENA_IMPORT_REPLACE=true # If true, the comments will be replaced if they already exist.
PHILOMENA_IMPORT_ID_MAP=import_id_map.json
```


## Explanation of the Import Process in `index.js`

### 1. Establishing Database Connection
The script initiates a connection to the PostgreSQL database:
- **Logging Connection Status**: The connection status is logged to ensure the database is accessible.
- **Checking Required Tables**: It verifies the existence of necessary tables (`images`, `comments`, `users`). If any table is missing, the script exits with an error.
- **Fetching Data**: The image and user data are retrieved from the database and stored in `imagesDB` and `usersDB`. This data is used later to map comments correctly during the import process.
```log
Import database connected
Table 'images' found in the database.
Table 'comments' found in the database.
Table 'users' found in the database.
```


### 2. Connecting to OpenSearch
The script connects to an OpenSearch instance:
- **Checking Index**: It checks if the required OpenSearch index for comments exists. If not, appropriate actions are taken based on the index's status or non-existence.
```log
Connected to OpenSearch
Index 'comments' found in OpenSearch
```

### 3. Defining Comment Structure and Reading CSV Files
The script defines the structure for comments:
- **Structure Definition**: The comment structure includes data types and callbacks for processing specific fields.
- **Reading CSV Files**: The script reads and parses the CSV files for comments and users, converting the data into JSON format. Depending on the size of the CSV files, this step may take up to 15 minutes.
- **Mapping CSV to Database Columns**: The script maps the CSV columns to the corresponding database columns based on the definition of the comment structure.
- **Processing Comments**: It processes each comment, applying necessary transformations and handling any errors during this phase.
```log
----------------------------------------
Parsing CSV file: comments-export.csv
Parsing CSV file: users-export.csv
----------------------------------------
Mapping CSV columns to DB 'comments' table columns
----------------------------------------
Processing Comments - Complete
Total Processing Time: 15:00
Total Comments Processed: 50,000
----------------------------------------
```

### 4. Importing Comments
If importing is enabled (`PHILOMENA_IMPORT=true`):
- **Batch Processing**: The comments are inserted or updated in the PostgreSQL database and indexed in OpenSearch. Depending on the size of the data, this can take up to an hour.
- **Batch Insertion**: Comments are inserted in batches to optimise performance.
    - **User Statistics Adjustment**: User statistics and image comment counts are updated.
    - **Saving Import ID Map**: An import ID map is saved for future reference, ensuring duplicate comments are not re-imported.
- **Logging Details**: Detailed processing logs are maintained throughout.
```log
----------------------------------------
Starting Database Import
Last ID: 217
 - SKIPPING COMMENT ID: 5680577 HAS NO IMAGE ID
 - INSERTING COMMENT ID: 218
 - UPDATING COMMENT ID: 219
 - INSERTING COMMENT ID: 220
 - UPDATING COMMENT ID: 221
----------------------------------------
BATCH INSERT: 2
 - BATCH INSERT: 218, 220
----------------------------------------
BATCH UPDATE: 2
 - BATCH UPDATE: 219, 221
----------------------------------------
Saved import ID map to import_id_map.json
Adjusting user statistics
Adjusting image comments count...
----------------------------------------
 ```

### 5. Cleanup Operations
After processing:
- **Closing Connections**: The script closes the database and OpenSearch connections, ensuring all resources are adequately cleaned up.
- **Logging Final Details**: Processing details, including any errors or issues encountered, are logged for review.
```log
Finished & Database connection closed. Total time: 1:00:00
```

### Re-running the Script
If the script is executed again, it checks the `PHILOMENA_IMPORT_ID_MAP` file:
- **Updating Instead of Inserting**: If the comment already exists (based on the import ID map), the script updates the comment instead of inserting it as new.
    

## Running the application
To run the application, you can use the following command:
```bash
npm install
npm start
```

## Watch a video of the import process in action

https://www.youtube.com/watch?v=7uwOx6tWVVs

[![Watch the video](https://img.youtube.com/vi/7uwOx6tWVVs/maxresdefault.jpg)](https://www.youtube.com/watch?v=7uwOx6tWVVs)
