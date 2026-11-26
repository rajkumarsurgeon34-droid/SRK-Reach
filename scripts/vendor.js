// Copies jsPDF into www/vendor so PDF saving works inside the app (no internet needed).
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "node_modules", "jspdf", "dist", "jspdf.umd.min.js");
const dst = path.join(__dirname, "..", "www", "vendor");
fs.mkdirSync(dst, { recursive: true });
fs.copyFileSync(src, path.join(dst, "jspdf.umd.min.js"));
console.log("jsPDF copied to www/vendor");
