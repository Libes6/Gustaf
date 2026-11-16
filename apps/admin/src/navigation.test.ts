import { describe, expect, it } from "vite-plus/test";

import { NAV_GROUPS, resolveActiveNav } from "./navigation";

const active = (pathname: string) => {
  const nav = resolveActiveNav(pathname);
  return nav ? [nav.group.id, nav.item.to, nav.nested] : null;
};

describe("resolveActiveNav", () => {
  it("matches list routes and their detail routes to the owning group", () => {
    expect(active("/")).toEqual(["overview", "/", false]);
    expect(active("/users")).toEqual(["accounts", "/users", false]);
    expect(active("/users/")).toEqual(["accounts", "/users", false]);
    expect(active("/users/u_42")).toEqual(["accounts", "/users", true]);
    expect(active("/reports/r_7")).toEqual(["control", "/reports", true]);
    expect(active("/ai-usage")).toEqual(["infrastructure", "/ai-usage", false]);
  });

  it("does not treat a shared prefix or an unknown path as a match", () => {
    expect(active("/usersx")).toBeNull();
    expect(active("/flagship")).toBeNull();
    expect(active("/nope")).toBeNull();
  });

  it("assigns every top-level path to exactly one group", () => {
    const paths = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.to));
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(resolveActiveNav(path)?.item.to).toBe(path);
  });
});
