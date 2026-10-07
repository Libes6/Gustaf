import { describe, expect, it } from "vitest";
import { executeSkill, loadSkills, requestedSkillPrompt } from "../../src/agent/skills";
import { callsOf, mockInvoke } from "./tauri";

describe("Skill loading", () => {
  it("retains builtins when discovery fails while strict UI loading reports the error", async () => {
    mockInvoke({
      skills_scan: () => {
        throw Error("Unavailable backend");
      },
    });
    expect((await loadSkills(null)).some((s) => s.name === "review")).toBe(true);
    await expect(loadSkills(null, true)).rejects.toThrow("Unavailable backend");
  });
  it("loads bodies lazily and invokes the last user command only", async () => {
    mockInvoke({
      skills_scan: [
        { id: "project:.agents/skills/demo/SKILL.md", name: "demo", description: "Demo", source: "project" },
      ],
      skills_read: "---\nname: demo\n---\nDo the demo",
    });
    const skills = await loadSkills("/project");
    expect(callsOf("skills_read")).toHaveLength(0);
    const prompt = await requestedSkillPrompt(
      "/project",
      [{ role: "user", parts: [{ type: "text", text: "/demo src/index.ts" }] }],
      skills,
    );
    expect(prompt).toContain("Do the demo");
    expect(prompt).toContain("src/index.ts");
    expect(callsOf("skills_read")).toEqual([{ root: "/project", id: "project:.agents/skills/demo/SKILL.md" }]);
    expect(
      await requestedSkillPrompt(
        "/project",
        [
          { role: "user", parts: [{ type: "text", text: "/demo" }] },
          { role: "user", parts: [{ type: "text", text: "What next?" }] },
        ],
        skills,
      ),
    ).toBe("");
  });
  it("rejects unknown commands and invalid arguments rather than silently doing a different task", async () => {
    const skills = await loadSkills(null);
    await expect(executeSkill(null, skills, "not-a-skill")).rejects.toThrow("Unknown skill");
    await expect(executeSkill(null, skills, "review", { permission: "full" })).rejects.toThrow(
      "Invalid skill arguments",
    );
    expect(callsOf("skills_read")).toHaveLength(0);
  });
});
