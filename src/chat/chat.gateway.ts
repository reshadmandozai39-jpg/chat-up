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
    if (typeof requestedRoom !== 'string') {
      client.emit('roomError', 'Bitte gib einen gültigen Raumnamen ein.');
      return;
    }

    const room = requestedRoom.trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,40}$/.test(room)) {
      client.emit('roomError', 'Der Raumname darf nur Buchstaben, Zahlen, _ und - enthalten.');
      return;
    }

    const previousRoom = client.data.room as string | undefined;
    if (previousRoom === room) {
      client.emit('roomJoined', { room });
      return;
    }

    const roomSize = this.server.sockets.adapter.rooms.get(room)?.size ?? 0;
    if (roomSize >= 2) {
      client.emit('roomError', 'Dieser Raum ist bereits mit zwei Personen belegt.');
      return;
    }

    if (previousRoom) await client.leave(previousRoom);
    await client.join(room);
    client.data.room = room;
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
      senderId: client.id,
      user: sender,
      message: message.trim(),
    });
  }
}
