import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { CanvasWorkspace } from "../src/components/CanvasWorkspace";
import { Markdown } from "../src/components/Markdown";
import { I18nProvider } from "../src/i18n";
import "../src/styles/theme.css";
const fence = (id: string, title: string, code: string) =>
  `\`\`\`tsx-canvas id="${id}" title="${title}"\n${code}\n\`\`\``;
const sources = [
  fence(
    "counter",
    "Счётчик",
    `import { useState } from 'react'; export default function Counter() { const [n,setN]=useState<number>(0); return <div style={{padding:32}}><h1>Счётчик</h1><button onClick={()=>setN(n+1)}>Нажатий: {n}</button></div> }`,
  ),
  fence(
    "counter",
    "Счётчик",
    `export default function Counter() { const [n,setN]=React.useState(10); return <div style={{padding:32}}><h1>Версия 2</h1><button onClick={()=>setN(n+2)}>Нажатий: {n}</button></div> }`,
  ),
  fence(
    "multi",
    "Несколько файлов",
    `// file: App.tsx\nimport { Heart } from 'lucide-react';\nimport { greet } from './lib/greet';\nexport default () => <div style={{padding:24}}><Heart /> {greet('мир')}</div>;\n// file: lib/greet.ts\nexport const greet = (n: string) => 'Привет, ' + n;`,
  ),
  fence(
    "multi",
    "Несколько файлов",
    `// file: App.tsx\nimport { Heart } from 'lucide-react';\nimport { greet } from './lib/greet';\nimport { Footer } from './Footer';\nexport default () => <div style={{padding:24}}><Heart /> {greet('мир!')}<Footer /></div>;\n// file: lib/greet.ts\nexport const greet = (n: string) => 'Привет, ' + n;\n// file: Footer.tsx\nexport const Footer = () => <small>footer</small>;`,
  ),
  fence(
    "broken",
    "Ошибка выполнения",
    `export default function Broken() { throw new Error('Example runtime error'); }`,
  ),
  fence("syntax", "Ошибка TSX", `export default function Broken( { return <div>`),
  fence(
    "isolation",
    "Проверка изоляции",
    `export default function Check() { const [result,setResult]=React.useState(''); async function check(){ let parentBlocked=false,storageBlocked=false,networkBlocked=false; try { parent.document.title } catch { parentBlocked=true } try { localStorage.getItem('x') } catch { storageBlocked=true } try { await fetch('https://example.com') } catch { networkBlocked=true } setResult(JSON.stringify({parentBlocked,storageBlocked,networkBlocked,nativeBridge:!!window.__TAURI_INTERNALS__})); } return <div style={{padding:24}}><button onClick={check}>Проверить изоляцию</button><pre>{result}</pre></div> }`,
  ),
  fence(
    "escape",
    "Строка HTML",
    `export default () => <pre>{'</script><script>parent.document.body.innerHTML="BAD"</script>'}</pre>`,
  ),
];
function Fixture() {
  const [draft, setDraft] = useState("");
  return (
    <I18nProvider locale="ru">
      <CanvasWorkspace sources={sources} scope="fixture" onRepair={setDraft}>
        <main className="main">
          <div className="feed" style={{ padding: 24 }}>
            <h2>Canvas integration fixture</h2>
            {sources.map((text, i) => (
              <Markdown key={i} text={text} />
            ))}
            <Markdown text={'```tsx-canvas title="Ещё генерируется"\nexport default'} />
            <textarea aria-label="Repair draft" value={draft} readOnly style={{ width: "100%", minHeight: 100 }} />
          </div>
        </main>
      </CanvasWorkspace>
    </I18nProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
