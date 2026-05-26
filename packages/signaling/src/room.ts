import type WebSocket from "ws";

export interface Peer {
  id: string;         // ZFA capability token (hex-encoded)
  ws: WebSocket;
  joinedAt: number;
}

/// A room groups peers that want to connect to each other.
/// Room IDs are ZFA capability tokens — possessing the room ID is the capability to join.
export class Room {
  readonly id: string;
  private peers = new Map<string, Peer>();

  constructor(id: string) {
    this.id = id;
  }

  add(peer: Peer): void {
    this.peers.set(peer.id, peer);
  }

  remove(peerId: string): void {
    this.peers.delete(peerId);
  }

  get size(): number {
    return this.peers.size;
  }

  get isEmpty(): boolean {
    return this.peers.size === 0;
  }

  /// Forward a message to a specific peer.
  send(targetId: string, msg: unknown): boolean {
    const peer = this.peers.get(targetId);
    if (!peer || peer.ws.readyState !== 1 /* OPEN */) return false;
    peer.ws.send(JSON.stringify(msg));
    return true;
  }

  /// Broadcast to all peers except the sender.
  broadcast(senderId: string, msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const [id, peer] of this.peers) {
      if (id !== senderId && peer.ws.readyState === 1) {
        peer.ws.send(payload);
      }
    }
  }

  peerIds(): string[] {
    return [...this.peers.keys()];
  }
}
