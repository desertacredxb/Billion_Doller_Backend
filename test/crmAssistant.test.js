const assert = require("node:assert/strict");
const test = require("node:test");
const { createCrmAssistant } = require("../services/crmAssistant.service");

test("the CRM assistant drafts replies from public facts and refuses private text before calling OpenAI", async () => {
  const requests = [];
  const assistant = createCrmAssistant({ env: {}, usage: { reserve: async () => true }, client: {
    responses: { create: async request => { requests.push(request); return { output_text: "Please use Continue to Verify in the client area." }; } },
  } });
  await assert.rejects(assistant.ask("Client number is +1 202-555-0101"), { status: 400 });
  assert.deepEqual(requests, []);
  assert.deepEqual(await assistant.ask(" How can a client complete verification? "), { reply: "Please use Continue to Verify in the client area." });
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].input, "How can a client complete verification?");
  assert.match(requests[0].instructions, /Do not promise approval/);
});

test("a bounded voice upload becomes editable text before a reply is requested", async () => {
  const assistant = createCrmAssistant({ env: {}, usage: { reserve: async () => true }, client: {
    audio: { transcriptions: { create: async ({ file, model }) => {
      assert.equal(file.name, "question.webm");
      assert.equal(model, "gpt-transcribe");
      return { text: " How do I reset a password? " };
    } } },
  } });
  await assert.rejects(assistant.transcribe({ mimetype: "application/pdf", buffer: Buffer.from("fixture") }), { status: 400 });
  assert.deepEqual(await assistant.transcribe({ mimetype: "audio/webm", buffer: Buffer.from("fixture") }), { text: "How do I reset a password?" });
});
