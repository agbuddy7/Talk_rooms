const GENERIC = new Set([
  "better", "really", "still", "right", "whole", "streamer", "character", "quest",
  "story", "storyline", "ending", "choice", "conversation", "viewers", "today",
  "funny", "team", "supporters", "clearly", "secret", "stronger", "incredible"
]);

const capitalize = (value) => value ? value[0].toUpperCase() + value.slice(1) : value;
const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export class ViewerMatcher {
  constructor(options = {}) {
    this.options = {
      streamId: "demo-stream", minMembers: 2, maxMembers: 8,
      roomTtlMs: 120_000, minConfidence: 0.55, maxRooms: 4,
      minTopicScore: 0, minTopicViewers: 0, minTopicMessages: 0, minTopicCoherence: 0,
      maxDuplicatePenalty: 1, minAverageTokens: 0, minDetailedMessageRatio: 0,
      requireAnalysis: false,
      ignoredTokens: [], ...options
    };
    this.options.ignoredTokens = new Set(this.options.ignoredTokens.map((token) => token.toLowerCase()).filter(Boolean));
    this.roomMemory = new Map();
  }

  reset() { this.roomMemory.clear(); }

  match(detector, state, now = Date.now()) {
    for (const topic of state.topics.filter((item) =>
      item.status === "hot" &&
      item.score >= this.options.minTopicScore &&
      item.uniqueViewers >= this.options.minTopicViewers &&
      item.messageCount >= this.options.minTopicMessages &&
      item.coherence >= this.options.minTopicCoherence &&
      item.duplicatePenalty <= this.options.maxDuplicatePenalty &&
      item.averageTokens >= this.options.minAverageTokens &&
      item.detailedMessageRatio >= this.options.minDetailedMessageRatio
    )) {
      const cluster = detector.clusters.get(topic.id);
      if (!cluster) continue;
      if (this.options.requireAnalysis && !cluster.analysis) continue;
      if (cluster.analysis?.roomRecommended === false) continue;
      const currentRoomIds = new Set();
      const inferredGroups = cluster.analysis?.viewpoints?.length
        ? this.groupsFromAnalysis(cluster)
        : this.inferGroups(cluster);
      const groups = this.makeViewerAssignmentsExclusive(inferredGroups);
      for (const group of groups) {
        const members = this.membersFor(group.messages, topic.score);
        if (members.length < this.options.minMembers) continue;
        const chunk = members.slice(0, this.options.maxMembers);
        const id = "room-" + topic.id + "-" + slug(group.label);
        const previous = this.roomMemory.get(id);
        const room = {
          id, streamId: this.options.streamId, topicId: topic.id, topicTitle: topic.title,
          name: cluster.analysis?.roomTitle ?? this.roomName(group.label, topic.title, id),
          viewpoint: group.label, topicScore: topic.score,
          lastEvidenceAt: Math.max(...chunk.map((member) => member.lastActiveAt)),
          status: "invitation-ready", invitationOnly: true,
          createdAt: previous?.createdAt ?? new Date(now).toISOString(),
          expiresAt: new Date(now + this.options.roomTtlMs).toISOString(),
          members: chunk
        };
        this.roomMemory.set(id, room);
        currentRoomIds.add(id);
      }
      for (const [id, room] of this.roomMemory) {
        if (room.topicId === topic.id && !currentRoomIds.has(id)) this.roomMemory.delete(id);
      }
    }
    for (const [id, room] of this.roomMemory) if (Date.parse(room.expiresAt) < now) this.roomMemory.delete(id);
    return this.makeActiveInvitationsExclusive([...this.roomMemory.values()])
      .sort((a, b) => b.topicScore - a.topicScore || b.lastEvidenceAt - a.lastEvidenceAt)
      .slice(0, this.options.maxRooms);
  }

  roomName(viewpoint, topicTitle, seed) {
    const subject = viewpoint === "Shared reaction"
      ? topicTitle.split(":")[0].replace(/chat (reacts|is not happy)$/i, "").trim()
      : viewpoint;
    const suffixes = ["Afterparty", "Unfiltered", "Debrief"];
    const hash = [...seed].reduce((total, character) => total + character.charCodeAt(0), 0);
    return (subject || "Live Moment") + " " + suffixes[hash % suffixes.length];
  }

  makeActiveInvitationsExclusive(rooms) {
    const winnerByViewer = new Map();
    for (const room of rooms) {
      for (const member of room.members) {
        const winner = winnerByViewer.get(member.userId);
        if (!winner || member.lastActiveAt > winner.member.lastActiveAt ||
          (member.lastActiveAt === winner.member.lastActiveAt && member.confidence > winner.member.confidence)) {
          winnerByViewer.set(member.userId, { roomId: room.id, member });
        }
      }
    }
    return rooms.map((room) => ({
      ...room,
      members: room.members.filter((member) => winnerByViewer.get(member.userId)?.roomId === room.id)
    })).filter((room) => room.members.length >= this.options.minMembers);
  }

  groupsFromAnalysis(cluster) {
    const byId = new Map(cluster.messages.map((message) => [message.id, message]));
    return cluster.analysis.viewpoints.map((viewpoint) => ({
      label: viewpoint.label,
      messages: viewpoint.supportingMessageIds.map((id) => byId.get(id)).filter(Boolean)
    }));
  }

  makeViewerAssignmentsExclusive(groups) {
    const winnerByViewer = new Map();
    groups.forEach((group, groupIndex) => {
      const evidence = new Map();
      for (const message of group.messages) {
        const current = evidence.get(message.userId) ?? { count: 0, lastActiveAt: 0 };
        current.count += 1;
        current.lastActiveAt = Math.max(current.lastActiveAt, message.timestamp);
        evidence.set(message.userId, current);
      }
      for (const [userId, score] of evidence) {
        const winner = winnerByViewer.get(userId);
        if (!winner || score.count > winner.count || (score.count === winner.count && score.lastActiveAt > winner.lastActiveAt)) {
          winnerByViewer.set(userId, { groupIndex, ...score });
        }
      }
    });
    return groups.map((group, groupIndex) => ({
      ...group,
      messages: group.messages.filter((message) => winnerByViewer.get(message.userId)?.groupIndex === groupIndex)
    }));
  }

  inferGroups(cluster) {
    const messages = cluster.messages;
    const counts = new Map();
    for (const message of messages) {
      for (const token of new Set(message.tokens)) {
        if (!GENERIC.has(token) && !this.options.ignoredTokens.has(token) && token.length >= 4) counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    const anchors = [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([token]) => token);
    if (!anchors.length) return [{ label: "Shared reaction", messages }];
    if (anchors.length === 1) return [{ label: capitalize(anchors[0]), messages }];

    const groups = new Map(anchors.map((anchor) => [anchor, []]));
    for (const message of messages) {
      const present = anchors.filter((anchor) => message.tokens.includes(anchor));
      if (!present.length) continue;
      const winner = present.sort((a, b) => this.stanceScore(message.normalized, b) - this.stanceScore(message.normalized, a))[0];
      groups.get(winner).push(message);
    }
    const useful = [...groups.entries()].filter(([, groupMessages]) => new Set(groupMessages.map((message) => message.userId)).size >= this.options.minMembers);
    return useful.length ? useful.map(([label, groupMessages]) => ({ label: capitalize(label), messages: groupMessages })) : [{ label: "Shared reaction", messages }];
  }

  stanceScore(text, anchor) {
    const index = text.indexOf(anchor);
    if (index < 0) return -1;
    const nearby = text.slice(Math.max(0, index - 12), index + anchor.length + 28);
    const cues = ["better", "right", "wanted", "deserved", "stronger", "fits", "prefer", "love", "agree"];
    return 1 + cues.reduce((score, cue) => score + (nearby.includes(cue) ? 1 : 0), 0);
  }

  membersFor(messages, topicScore) {
    const viewers = new Map();
    for (const message of messages) {
      if (!message.userId || message.userId === "anonymous") continue;
      const viewer = viewers.get(message.userId) ?? {
        userId: message.userId, displayName: message.displayName, messages: 0, lastActiveAt: 0
      };
      viewer.messages += 1;
      viewer.lastActiveAt = Math.max(viewer.lastActiveAt, message.timestamp);
      viewers.set(message.userId, viewer);
    }
    return [...viewers.values()].map((viewer) => ({
      ...viewer,
      confidence: Number(Math.min(0.98, 0.48 + topicScore * 0.32 + Math.min(0.16, viewer.messages * 0.08)).toFixed(2))
    })).filter((viewer) => viewer.confidence >= this.options.minConfidence)
      .sort((a, b) => b.confidence - a.confidence || b.lastActiveAt - a.lastActiveAt);
  }
}
