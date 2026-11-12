const assert = require("node:assert/strict");
const test = require("node:test");
const { createCrmAssistant } = require("../services/crmAssistant.service");

test("the CRM assistant requires BDFX website search and refuses private text before calling OpenAI", async () => {
  const requests = [];
  const reply = "Please use Continue to Verify in the client area.";
  const output = `${reply} [Help Centre](https://www.billiondollarfx.com/help-centre?utm_source=openai)`;
  const assistant = createCrmAssistant({ env: {}, usage: { reserve: async () => true }, client: {
    responses: { create: async request => {
      requests.push(request);
      return { output: [{ type: "message", content: [{ type: "output_text", text: output, annotations: [
        { type: "url_citation", url: "https://www.billiondollarfx.com/help-centre?utm_source=openai", title: "Help Centre", end_index: output.length },
        { type: "url_citation", url: "https://billiondollarfx.com.example.org/help-centre", end_index: reply.length },
      ] }] }] };
    } },
  } });
  await assert.rejects(assistant.ask("Client number is +1 202-555-0101"), { status: 400 });
  assert.deepEqual(requests, []);
  const spokenReply = `${reply} Help Centre`;
  assert.deepEqual(await assistant.ask(" How can a client complete verification? "), {
    reply: spokenReply, sources: [{ url: "https://www.billiondollarfx.com/help-centre", title: "Help Centre", end: spokenReply.length }],
  });
  assert.equal(requests[0].store, false);
  assert.equal(requests[0].input, "How can a client complete verification?");
  assert.deepEqual(requests[0].tools[0].filters.allowed_domains, ["billiondollarfx.com"]);
  assert.equal(requests[0].tool_choice, "required");
  assert.equal(requests[0].reasoning.effort, "low");
  assert.match(requests[0].instructions, /Do not promise approval/);
});

test("a reply without official sources sends staff to the BDFX Help Centre", async () => {
  const assistant = createCrmAssistant({ env: {}, usage: { reserve: async () => true }, client: {
    responses: { create: async () => ({ output: [{ type: "message", content: [{ type: "output_text",
      text: "The minimum deposit is $123.", annotations: [],
    }] }] }) },
  } });
  const result = await assistant.ask("What is the minimum deposit?");
  assert.match(result.reply, /couldn't verify/);
  assert.equal(result.sources[0].url, "https://www.billiondollarfx.com/help-centre");
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
