const dotenv = require("dotenv");
const path = require("path");

// Determine the current environment (e.g., 'development', 'production', 'test')
const env = process.env.NODE_ENV || "development";

// Resolve the absolute path to the correct .env file based on the environment
const envPath = path.resolve(process.cwd(), `.env.${env}`);

// Load environment variables from the resolved .env file into process.env
dotenv.config({ path: envPath });

// Optional: log which env file was loaded
console.log(`Loaded environment variables from ${envPath}`);
console.log(process.env)

// No need to export anything: process.env is global in Node
