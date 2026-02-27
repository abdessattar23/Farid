// Importing each tool module triggers registerTool() calls
import "./linear";
import "./reminder";
import "./productivity";
import "./notes";
import "./journal";
import "./habits";
import "./web";
import "./github";
import "./planner";
import "./phone";
import "./phone-agent";
import "./contact";

export { executeTool, generateToolsParam, getAllTools } from "./registry";
