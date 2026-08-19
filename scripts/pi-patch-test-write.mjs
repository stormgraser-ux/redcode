// Verify the write tool now accepts a JSON object for `content`.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { rmSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
// Ask npm where the package lives rather than shelling out to `which`/`where`,
// which are not Windows programs (and `where pi` would resolve to the .cmd
// shim, not dist). Same resolution as scripts/pi-patch.
const npmRoot = execFileSync("npm", ["root", "-g"], {
  encoding: "utf8",
  shell: process.platform === "win32",
}).trim();
const dist = join(npmRoot, "@earendil-works", "pi-coding-agent", "dist");
const { createWriteToolDefinition } = await import(pathToFileURL(join(dist,"core","tools","write.js")).href);

const dir = mkdtempSync(join(tmpdir(),"wc-"));
const def = createWriteToolDefinition(dir);
let pass=0; const fails=[];
const check=(n,c,d="")=>{ c?pass++:fails.push(`  ${n}${d?" — "+d:""}`); };

check("prepareArguments installed", typeof def.prepareArguments === "function");

// 1. object content -> pretty JSON string
const obj = { name:"pkg", nested:{ a:[1,2] } };
const out = def.prepareArguments({ path:"a.json", content: obj });
check("object coerced to string", typeof out.content === "string", typeof out.content);
check("pretty-printed", out.content.includes('\n  "name"'), JSON.stringify(out.content).slice(0,60));
check("trailing newline", out.content.endsWith("\n"));
check("round-trips", JSON.stringify(JSON.parse(out.content)) === JSON.stringify(obj));
check("path preserved", out.path === "a.json");

// 2. strings pass through untouched (identity, not a copy)
const strIn = { path:"b.txt", content:"hello" };
check("string content untouched", def.prepareArguments(strIn) === strIn);

// 3. arrays are objects too — but a JSON file can legitimately be an array
const arr = def.prepareArguments({ path:"c.json", content:[1,2,3] });
check("array coerced", arr.content === "[\n  1,\n  2,\n  3\n]\n", JSON.stringify(arr.content));

// 4. null / undefined / non-object inputs must not throw
check("null content passes through", def.prepareArguments({path:"d",content:null}).content === null);
check("no content passes through", def.prepareArguments({path:"d"}).content === undefined);
check("non-object input", def.prepareArguments(null) === null);
check("number content", def.prepareArguments({path:"d",content:5}).content === 5);

// 5. circular must fall through to validation rather than throw
const circ = {}; circ.self = circ;
let threw=false;
try { const r = def.prepareArguments({path:"e.json",content:circ}); check("circular returns input", r.content === circ); }
catch { threw=true; }
check("circular does not throw", !threw);

// 6. the real end-to-end path: execute with an object, file lands as JSON
const res = await def.execute("id1", def.prepareArguments({ path:"real.json", content:{ ok:true } }), undefined, ()=>{}, {});
const written = readFileSync(join(dir,"real.json"),"utf8");
check("file written as valid JSON", JSON.parse(written).ok === true, written);

rmSync(dir,{recursive:true,force:true});
const total=pass+fails.length;
console.log(`${pass}/${total} passed`);
if(fails.length){ console.log("FAILURES:\n"+fails.join("\n")); process.exit(1); }
