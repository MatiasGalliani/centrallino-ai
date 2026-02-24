import { Client } from "pg";
import { readFile, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function setupDatabase() {
    const client = new Client({
        host: process.env.DB_HOST || "localhost",
        port: Number(process.env.DB_PORT) || 5432,
        database: process.env.DB_NAME || "voiceai",
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "",
    })

    try {
        await client.connect();
        console.log("Connected to database");

        const migrationPath = join(__dirname, "../migrations/001_create_campaigns_table.sql");
        const migrationSQL = readFileSync(migrationPath, "utf-8");

        await client.query(migrationSQL);
        console.log("Table campaigns created successfully")

    } catch (error) {
        console.error("Error setting up database:", error);
        process.exit(1);
    } finally {
        await client.end();
    }
}

setupDatabase();
