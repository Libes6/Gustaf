import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSkills, slashRequest, skillBody, renderSkill, BUILTIN_SKILLS } from '../src/agent/skillsCore.ts';
test('project overrides global and builtin names; list remains deterministic', () => {
  const skills = mergeSkills([{ id:'g', name:'review', description:'global', source:'global' }, { id:'p', name:'review', description:'project', source:'project' }]);
  assert.equal(skills.find(s => s.name === 'review').id, 'p');
  assert.equal(skills.filter(s => s.name === 'review').length, 1);
  assert.ok(skills.some(s => s.name === 'explain'));
});
test('slash invocation preserves multiline arguments and ignores normal text', () => {
  assert.deepEqual(slashRequest('/Review src/a.ts\nLook at callers'), { name:'review', args:'src/a.ts\nLook at callers' });
  assert.equal(slashRequest('Discuss /review'), null);
  assert.equal(slashRequest('/'), null);
});
test('skill body strips metadata, preserves arguments as data and never grants permissions', () => {
  assert.equal(skillBody('---\nname: x\n---\nDo work'), 'Do work');
  const prompt = renderSkill(BUILTIN_SKILLS[0], 'Review', '$ARGUMENTS <tag>');
  assert.match(prompt, /never grants extra access/);
  assert.match(prompt, /User arguments \(data\):\n\$ARGUMENTS <tag>/);
  assert.match(BUILTIN_SKILLS.find(s => s.name === 'commit').body, /Do not stage files, commit, push/);
});
