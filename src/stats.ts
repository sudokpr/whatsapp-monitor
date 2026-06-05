import type { StoredMessage } from "./whatsapp.js";

export interface RankedUser {
  sender: string;
  count: number;
}

export interface RankedGroup {
  groupId: string;
  count: number;
}

export class StatsStore {
  readonly messagesPerDay: Record<string, number> = {};
  readonly messagesPerUser: Record<string, number> = {};
  readonly messagesPerGroup: Record<string, number> = {};

  record(message: StoredMessage): void {
    const day = new Date(message.timestamp).toISOString().slice(0, 10);

    increment(this.messagesPerDay, day);
    increment(this.messagesPerUser, message.sender);
    increment(this.messagesPerGroup, message.groupId);
  }

  getTopUsers(limit: number): RankedUser[] {
    return topEntries(this.messagesPerUser, limit).map(([sender, count]) => ({
      sender,
      count,
    }));
  }

  getTopGroups(limit: number): RankedGroup[] {
    return topEntries(this.messagesPerGroup, limit).map(([groupId, count]) => ({
      groupId,
      count,
    }));
  }
}

function increment(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function topEntries(
  counter: Record<string, number>,
  limit: number,
): Array<[string, number]> {
  return Object.entries(counter)
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(0, limit));
}
