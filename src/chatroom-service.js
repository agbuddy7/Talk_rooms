export class ChatroomService {
  constructor(options = {}) {
    this.options = { maxMessages: 100, maxMessageLength: 280, minMessageIntervalMs: 400, ...options };
    this.rooms = new Map();
    this.lastMessageAt = new Map();
    this.hiddenInvitations = new Map();
    this.mutedTopics = new Map();
    this.reports = [];
  }

  reset() {
    this.rooms.clear();
    this.lastMessageAt.clear();
    this.hiddenInvitations.clear();
    this.mutedTopics.clear();
    this.reports = [];
  }

  sync(suggestions, now = Date.now()) {
    const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.id));
    for (const suggestion of suggestions) {
      const existing = this.rooms.get(suggestion.id);
      const invitedMembers = suggestion.members.map((member) => ({ ...member }));
      this.rooms.set(suggestion.id, existing ? {
        ...existing, name: suggestion.name, topicTitle: suggestion.topicTitle, viewpoint: suggestion.viewpoint,
        expiresAt: suggestion.expiresAt, invitedMembers
      } : {
        id: suggestion.id, streamId: suggestion.streamId, topicId: suggestion.topicId,
        name: suggestion.name, topicTitle: suggestion.topicTitle, viewpoint: suggestion.viewpoint,
        createdAt: suggestion.createdAt, expiresAt: suggestion.expiresAt,
        status: "open", invitedMembers, joinedMembers: [], messages: []
      });
    }
    for (const [id, room] of this.rooms) {
      if (Date.parse(room.expiresAt) <= now || (!suggestionIds.has(id) && room.joinedMembers.length === 0)) this.rooms.delete(id);
    }
    return this.list(now);
  }

  list(now = Date.now()) {
    return [...this.rooms.values()].filter((room) => Date.parse(room.expiresAt) > now).map((room) => this.serialize(room));
  }

  forViewer(userId, now = Date.now()) {
    const viewerId = String(userId ?? "");
    return [...this.rooms.values()].filter((room) => {
      if (Date.parse(room.expiresAt) <= now) return false;
      if (!room.invitedMembers.some((member) => member.userId === viewerId)) return false;
      if ((this.hiddenInvitations.get(room.id + ":" + viewerId) ?? 0) > now) return false;
      if ((this.mutedTopics.get(room.streamId + ":" + room.topicId + ":" + viewerId) ?? 0) > now) return false;
      return true;
    }).map((room) => this.serialize(room));
  }

  get(id, now = Date.now()) {
    const room = this.rooms.get(id);
    if (!room || Date.parse(room.expiresAt) <= now) throw new Error("Room is unavailable or expired");
    return room;
  }

  join(id, viewer, now = Date.now()) {
    const room = this.get(id, now);
    const userId = String(viewer.userId ?? "").trim();
    const invited = room.invitedMembers.find((member) => member.userId === userId);
    if (!invited) throw new Error("This viewer was not invited to this room");
    if (!room.joinedMembers.some((member) => member.userId === userId)) {
      room.joinedMembers.push({ userId, displayName: invited.displayName });
      this.addSystemMessage(room, invited.displayName + " joined the room", now);
    }
    return this.serialize(room);
  }

  send(id, viewer, text, now = Date.now()) {
    const room = this.get(id, now);
    const userId = String(viewer.userId ?? "").trim();
    const member = room.joinedMembers.find((item) => item.userId === userId);
    if (!member) throw new Error("Join the room before sending a message");
    const cleanText = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!cleanText) throw new Error("Message cannot be empty");
    if (cleanText.length > this.options.maxMessageLength) throw new Error("Message is too long");
    const rateKey = id + ":" + userId;
    if (now - (this.lastMessageAt.get(rateKey) ?? 0) < this.options.minMessageIntervalMs) throw new Error("Please wait before sending another message");
    this.lastMessageAt.set(rateKey, now);
    room.messages.push({
      id: "chat-" + now + "-" + room.messages.length,
      type: "viewer", userId, displayName: member.displayName, text: cleanText,
      timestamp: new Date(now).toISOString()
    });
    room.messages = room.messages.slice(-this.options.maxMessages);
    return this.serialize(room);
  }

  dismiss(id, viewer, now = Date.now()) {
    const room = this.get(id, now);
    const userId = this.requireInvited(room, viewer);
    this.hiddenInvitations.set(id + ":" + userId, Date.parse(room.expiresAt));
    return { ok: true, action: "dismissed", roomId: id };
  }

  leave(id, viewer, now = Date.now()) {
    const room = this.get(id, now);
    const userId = this.requireInvited(room, viewer);
    const member = room.joinedMembers.find((item) => item.userId === userId);
    room.joinedMembers = room.joinedMembers.filter((item) => item.userId !== userId);
    this.hiddenInvitations.set(id + ":" + userId, Date.parse(room.expiresAt));
    if (member) this.addSystemMessage(room, member.displayName + " left the room", now);
    return { ok: true, action: "left", roomId: id };
  }

  mute(id, viewer, now = Date.now()) {
    const room = this.get(id, now);
    const userId = this.requireInvited(room, viewer);
    const until = now + 10 * 60_000;
    this.mutedTopics.set(room.streamId + ":" + room.topicId + ":" + userId, until);
    room.joinedMembers = room.joinedMembers.filter((item) => item.userId !== userId);
    return { ok: true, action: "muted", roomId: id, mutedUntil: new Date(until).toISOString() };
  }

  report(id, viewer, reason, now = Date.now()) {
    const room = this.get(id, now);
    const userId = this.requireInvited(room, viewer);
    const allowed = new Set(["harassment", "hate", "sexual", "spam", "unsafe", "other"]);
    const reportReason = String(reason ?? "").toLowerCase();
    if (!allowed.has(reportReason)) throw new Error("Choose a valid report reason");
    this.reports.push({
      id: "report-" + now + "-" + this.reports.length, roomId: id, topicId: room.topicId,
      streamId: room.streamId, reporterUserId: userId, reason: reportReason,
      createdAt: new Date(now).toISOString()
    });
    this.reports = this.reports.slice(-100);
    this.mute(id, viewer, now);
    return { ok: true, action: "reported", roomId: id };
  }

  requireInvited(room, viewer) {
    const userId = String(viewer.userId ?? "").trim();
    if (!room.invitedMembers.some((member) => member.userId === userId)) {
      throw new Error("This viewer was not invited to this room");
    }
    return userId;
  }

  addSystemMessage(room, text, now) {
    room.messages.push({
      id: "system-" + now + "-" + room.messages.length,
      type: "system", userId: null, displayName: "SideChat", text,
      timestamp: new Date(now).toISOString()
    });
  }

  serialize(room) {
    return {
      id: room.id, streamId: room.streamId, topicId: room.topicId,
      name: room.name, topicTitle: room.topicTitle, viewpoint: room.viewpoint,
      createdAt: room.createdAt, expiresAt: room.expiresAt, status: room.status,
      invitationOnly: true, members: room.invitedMembers,
      joinedMembers: room.joinedMembers, messages: room.messages
    };
  }
}
