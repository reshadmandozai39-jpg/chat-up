import { randomUUID } from 'node:crypto';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Socket } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(@MessageBody() requestedRoom: unknown, @ConnectedSocket() client: Socket) {
    const payload = typeof requestedRoom === 'object' && requestedRoom !== null
      ? requestedRoom as { room?: unknown; user?: unknown }
      : undefined;
    const roomValue = typeof requestedRoom === 'string' ? requestedRoom : payload?.room;
    if (typeof roomValue !== 'string') {
      client.emit('roomError', 'Bitte gib einen gültigen Raumnamen ein.');
      return;
    }

    const room = roomValue.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(room)) {
      client.emit('roomError', 'Der Raumname darf nur Buchstaben, Zahlen, _ und - enthalten.');
      return;
    }

    const user = typeof payload?.user === 'string' && payload.user.trim()
      ? payload.user.trim()
      : client.data.user || client.id;
    const previousRoom = client.data.room as string | undefined;
    const roomMembers = this.server.sockets.adapter.rooms.get(room) ?? new Set<string>();
    const otherParticipants = new Set(
      [...roomMembers]
        .filter((socketId) => socketId !== client.id)
        .map((socketId) => {
          const member = this.server.sockets.sockets.get(socketId);
          const memberUser = member?.data.user;
          return typeof memberUser === 'string' && memberUser.trim()
            ? memberUser.trim().toLowerCase()
            : `socket:${socketId}`;
        }),
    );
    if (!otherParticipants.has(user.toLowerCase()) && otherParticipants.size >= 2) {
      client.emit('roomError', 'Dieser Raum ist bereits mit zwei Personen belegt.');
      return;
    }

    if (previousRoom !== room) {
      if (previousRoom) await client.leave(previousRoom);
      await client.join(room);
    }
    client.data.room = room;
    client.data.user = user;
    client.emit('roomJoined', { room });
  }

  @SubscribeMessage('sendMessage')
  handleMessage(
    @MessageBody() payload: { user?: string; message?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const user = payload?.user;
    const message = payload?.message;

    if (!room || typeof message !== 'string' || !message.trim()) return;

    const sender = typeof user === 'string' && user.trim() ? user.trim() : client.id;
    this.server.to(room).emit('receivedMessage', {
      messageId: randomUUID(),
      senderId: client.id,
      user: sender,
      message: message.trim(),
    });
  }

  @SubscribeMessage('messageRead')
  handleMessageRead(
    @MessageBody() payload: { messageId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const messageId = payload?.messageId;

    if (!room || typeof messageId !== 'string' || !messageId) return;

    this.server.to(room).emit('messageRead', {
      messageId,
      readerId: client.id,
    });
  }
}
