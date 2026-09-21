class MemoryStore {
  constructor() {
    this.store = new Map();
  }

  async getMessages(conversationId) {
    return this.store.get(conversationId) || [];
  }

  async saveMessage(conversationId, role, content) {
    const history = this.store.get(conversationId) || [];
    history.push({
      role,
      content,
      createdAt: new Date(),
    });
    this.store.set(conversationId, history);
  }

  async clearHistory(conversationId) {
    this.store.delete(conversationId);
  }
}

module.exports = {
  memoryStore: new MemoryStore(),
};