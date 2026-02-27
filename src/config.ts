import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  evolution: {
    apiUrl: required("EVOLUTION_API_URL").replace(/\/+$/, ""),
    instance: required("EVOLUTION_INSTANCE"),
    apiKey: required("EVOLUTION_API_KEY"),
  },
  hackclub: {
    apiKey: required("HACKCLUB_API_KEY"),
    model: process.env.HACKCLUB_MODEL || "qwen/qwen3-32b",
    baseUrl: "https://ai.hackclub.com/proxy/v1",
  },
  linear: {
    apiKey: required("LINEAR_API_KEY"),
  },
  supabase: {
    url: required("SUPABASE_URL"),
    anonKey: required("SUPABASE_ANON_KEY"),
  },
  agent: {
    ownerNumber: required("OWNER_NUMBER"),
    port: parseInt(process.env.PORT || "3000", 10),
    timezone: process.env.TIMEZONE || "Africa/Casablanca",
  },
} as const;
