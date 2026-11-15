import { createElement } from "react";
import { render } from "../test/render";
import { expect, it } from "vite-plus/test";

import { applyThemeCss } from "./themeCss";

it("applies theme CSS and drops every rule that would load a remote file", async () => {
  await using screen = await render(createElement("div", { "data-theme-css-probe": "" }));
  const probe = screen.container.firstElementChild!;
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };

  applyThemeCss(`
    @import url(https://example.com/sheet.css);
    @namespace svg url(http://www.w3.org/2000/svg);
    @property --registered { syntax: "<url>"; inherits: false; initial-value: url(https://example.com/d); }
    @counter-style leak { system: cyclic; symbols: url(https://example.com/f); }
    @keyframes leak { to { background-image: url(https://example.com/g); } }
    :root { --leak: u\\72l(https://example.com/a); }
    [data-theme-css-probe] {
      color: rgb(1, 2, 3);
      background-image: u\\72l(https://example.com/b);
      list-style-image: var(--leak);
      border-image-source: var(--registered);
      mask-image: v\\61r(--none, u\\72l(https://example.com/e));
      @media (min-width: 0px) { cursor: url(https://example.com/c), auto; }
    }
  `);

  const style = getComputedStyle(probe);
  expect(style.color).toBe("rgb(1, 2, 3)");
  expect(style.backgroundImage).toBe("none");
  expect(style.listStyleImage).toBe("none");
  expect(style.borderImageSource).toBe("none");
  expect(style.maskImage).toBe("none");
  const kept = document.adoptedStyleSheets.flatMap((sheet) =>
    Array.from(sheet.cssRules, (rule) => rule.cssText),
  );
  expect(kept.join("\n")).not.toContain("example.com");
  expect(style.cursor).toBe("auto");

  applyThemeCss(`[data-theme-css-probe] { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"); animation: local-animation 2s steps(1) infinite; }
    @keyframes local-animation { to { opacity: .5; } }`);
  expect(getComputedStyle(probe).backgroundImage).toContain("data:image/svg+xml");
  expect(getComputedStyle(probe).animationName).toBe("local-animation");
  expect(
    document.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n"),
  ).toContain("@keyframes local-animation");
  applyThemeCss(undefined);
  expect(getComputedStyle(probe).animationName).toBe("none");
  expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");
});
