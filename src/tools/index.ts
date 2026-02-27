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

export { executeTool, generateToolsParam, getAllTools } from "./registry";
