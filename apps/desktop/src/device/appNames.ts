// Display names of the apps installed on an iOS simulator, in every name they can carry on the home screen: the
// English one from `simctl listapps` and the one of the simulator's language (`<lang>.lproj/InfoPlist.strings`).
// A tap on a home-screen icon is labelled with the localised name; this maps it back to the bundle id so the helper
// session can follow the app that opened. Pure parts here; the script runs under node on the same machine.

/** Prints `{ "<bundle id>": ["Settings", "Настройки"] }` for the apps JSON on stdin; $1 is the simulator's language list. */
export const APP_NAMES_SCRIPT = `const fs=require("fs"),cp=require("child_process");
const langs=(process.argv[1]||"").split(",").filter(Boolean);
const apps=JSON.parse(fs.readFileSync(0,"utf8"));const out={};
const read=(f)=>{try{return JSON.parse(cp.execFileSync("plutil",["-convert","json","-o","-",f],{stdio:["ignore","pipe","ignore"]}))}catch{return{}}};
for(const [b,a] of Object.entries(apps)){const names=new Set();
if(a.CFBundleDisplayName)names.add(a.CFBundleDisplayName);if(a.CFBundleName)names.add(a.CFBundleName);
for(const l of langs){for(const d of [l,l.split("-")[0],l.replace("-","_")]){const j=read(a.Path+"/"+d+".lproj/InfoPlist.strings");
for(const k of ["CFBundleDisplayName","CFBundleName"])if(j[k])names.add(j[k])}}
out[b]=[...names]}
console.log(JSON.stringify(out))`;

/** Parses `defaults read -g AppleLanguages` ("(\n    "ru-RU",\n    "en-RU"\n)") into ["ru-RU", "en-RU"]. */
export const parseLanguages = (s: string) =>
  [...s.matchAll(/"?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)"?\s*[,\n)]/g)].map((m) => m[1]).slice(0, 3);

/** The bundle id whose name matches the label of a home-screen icon ("Настройки", "Settings, 2 notifications"). */
export function bundleForLabel(names: Record<string, string[]>, label: string): string | undefined {
  const l = label.replace(/\s/g, " ").trim().toLowerCase();
  let best: string | undefined;
  let bestLen = 0;
  for (const [bundle, list] of Object.entries(names))
    for (const raw of list ?? []) {
      const n = raw.replace(/\s/g, " ").trim().toLowerCase();
      if (n.length > bestLen && (l === n || l.startsWith(`${n},`) || l.startsWith(`${n} `))) {
        best = bundle;
        bestLen = n.length;
      }
    }
  return best;
}
