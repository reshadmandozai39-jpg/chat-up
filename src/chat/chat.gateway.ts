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

  @SubscribeMessage('sendMessage')
  handleMessage(
    @MessageBody() payload: { user?: string; message?: string, room?: String } ,
    @ConnectedSocket() client: Socket,
  ) {
    const user = typeof payload === 'string' ? undefined : payload.user;
    const message = typeof payload === 'string' ? payload : payload.message;

    if (typeof message !== 'string' || !message.trim()) return;

    const sender = typeof user === 'string' && user.trim() ? user.trim() : client.id;
    console.log(`Message received from ${sender}: ${message}`);
    
    const room = 'alice-bob';
    client.join(room);


    this.server.to(room).emit('receivedMessage', {
  user: sender,
  message: payload.message?.trim(),
});

    
  }
}
