import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server } from 'socket.io';
import { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChatService } from './chat.service.js';

@WebSocketGateway({
  maxHttpBufferSize: 8 * 1024 * 1024,
  cors: {
    origin: '*',
  },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly chatService: ChatService) {}

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    const iceServers: RTCIceServer[] = [
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    const turnUrls = process.env.TURN_URLS
      ?.split(',')
      .map((url) => url.trim())
      .filter(Boolean);
    const turnUsername = process.env.TURN_USERNAME;
    const turnCredential = process.env.TURN_CREDENTIAL;

    if (turnUrls?.length && turnUsername && turnCredential) {
      iceServers.push({
        urls: turnUrls,
        username: turnUsername,
        credential: turnCredential,
      });
    }

    client.emit('call:config', { iceServers });
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    const activeCall = client.data.activeCall;
    if (activeCall) {
      const peer = this.server.sockets.sockets.get(activeCall.peerSocketId);
      if (peer && peer.data.activeCall?.callId === activeCall.callId) {
        delete peer.data.activeCall;
        peer.emit('call:ended', { callId: activeCall.callId, reason: 'peer-disconnected' });
      }
    }

    const pendingCall = client.data.pendingCall;
    if (pendingCall) {
      const peer = this.server.sockets.sockets.get(pendingCall.peerSocketId);
      delete client.data.pendingCall;
      if (peer && peer.data.incomingCall?.callId === pendingCall.callId) {
        delete peer.data.incomingCall;
        peer.emit('call:ended', { callId: pendingCall.callId, reason: 'peer-disconnected' });
      }
    }

    const incomingCall = client.data.incomingCall;
    if (incomingCall) {
      const caller = this.server.sockets.sockets.get(incomingCall.callerSocketId);
      delete client.data.incomingCall;
      if (caller && caller.data.pendingCall?.callId === incomingCall.callId) {
        delete caller.data.pendingCall;
        caller.emit('call:ended', { callId: incomingCall.callId, reason: 'peer-disconnected' });
      }
    }
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @MessageBody() requestedRoom: unknown,
    @ConnectedSocket() client: Socket,
  ) {
    const payload = typeof requestedRoom === 'object' && requestedRoom !== null
      ? requestedRoom as { room?: unknown; user?: unknown; email?: unknown }
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

    try {
      const email = typeof payload?.email === 'string' ? payload.email.trim() : undefined;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        client.emit('roomError', 'Bitte gib eine gültige E-Mail-Adresse ein.');
        return;
      }
      const storedUser = await this.chatService.getOrCreateMockUser(user, email);
      const storedRoom = await this.chatService.getOrCreateChatRoom(room);
      client.data.userId = storedUser.id;
      client.data.chatRoomId = storedRoom.id;
    } catch {
      client.emit('roomError', 'User oder Chatraum konnten nicht in der Datenbank gespeichert werden.');
      return;
    }

    if (previousRoom !== room) {
      if (previousRoom) await client.leave(previousRoom);
      await client.join(room);
    }
    client.data.room = room;
    client.data.user = user;
    client.emit('roomJoined', { room, userId: client.data.userId });

    try {
      const messages = await this.chatService.getRecentMessages(client.data.chatRoomId);
      client.emit('messageHistory', messages.map((message) => ({
        messageId: String(message.id),
        userId: message.senderId,
        user: message.sender.LastName === 'Mock'
          ? message.sender.firstName
          : `${message.sender.firstName} ${message.sender.LastName}`,
        message: message.content,
        type: message.type,
        createdAt: message.createdAt.toISOString(),
      })));
    } catch {
      client.emit('messageHistoryError', 'Der gespeicherte Verlauf konnte nicht geladen werden.');
    }
  }

  @SubscribeMessage('sendMessage')
  async handleMessage(
    @MessageBody() payload: { user?: string; message?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const userId = client.data.userId;
    const chatRoomId = client.data.chatRoomId;
    const message = payload?.message;

    if (
      !room ||
      !Number.isInteger(userId) ||
      !Number.isInteger(chatRoomId) ||
      typeof message !== 'string' ||
      !message.trim()
    ) return;

    let storedMessage;
    try {
      storedMessage = await this.chatService.saveMessage(
        userId,
        chatRoomId,
        message.trim(),
      );
    } catch {
      client.emit('messageError', 'Die Nachricht konnte nicht in der Datenbank gespeichert werden.');
      return;
    }

    this.server.to(room).emit('receivedMessage', {
      messageId: String(storedMessage.id),
      senderId: client.id,
      userId,
      user: client.data.user || client.id,
      message: message.trim(),
      type: 'TEXT',
      createdAt: storedMessage.createdAt.toISOString(),
    });
  }

  @SubscribeMessage('sendAudioMessage')
  async handleAudioMessage(
    @MessageBody() payload: { mimeType?: unknown; data?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const userId = client.data.userId;
    const chatRoomId = client.data.chatRoomId;
    const mimeType = typeof payload?.mimeType === 'string'
      ? payload.mimeType.split(';')[0].trim().toLowerCase()
      : '';
    const extensions: Record<string, string> = {
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mp4': 'm4a',
      'audio/wav': 'wav',
      'audio/wave': 'wav',
    };
    const audio = payload?.data;

    if (
      !room ||
      !Number.isInteger(userId) ||
      !Number.isInteger(chatRoomId) ||
      (!Buffer.isBuffer(audio) && !(audio instanceof Uint8Array)) ||
      !extensions[mimeType]
    ) {
      client.emit('messageError', 'Die Sprachnachricht hat ein ungültiges Format.');
      return;
    }

    const audioBuffer = Buffer.from(audio);
    if (audioBuffer.length === 0 || audioBuffer.length > 8 * 1024 * 1024) {
      client.emit('messageError', 'Die Sprachnachricht ist leer oder größer als 8 MB.');
      return;
    }

    const filename = `${randomUUID()}.${extensions[mimeType]}`;
    const uploadDirectory = join(process.env.UPLOADS_DIR || join(process.cwd(), 'uploads'), 'audio');
    const audioPath = `/uploads/audio/${filename}`;

    try {
      await mkdir(uploadDirectory, { recursive: true });
      await writeFile(join(uploadDirectory, filename), audioBuffer, { flag: 'wx' });
    } catch {
      client.emit('messageError', 'Die Sprachnachricht konnte nicht gespeichert werden.');
      return;
    }

    let storedMessage;
    try {
      storedMessage = await this.chatService.saveMessage(
        userId,
        chatRoomId,
        audioPath,
        'AUDIO',
      );
    } catch {
      await unlink(join(uploadDirectory, filename)).catch(() => undefined);
      client.emit('messageError', 'Die Sprachnachricht konnte nicht in der Datenbank gespeichert werden.');
      return;
    }

    this.server.to(room).emit('receivedMessage', {
      messageId: String(storedMessage.id),
      senderId: client.id,
      userId,
      user: client.data.user || client.id,
      message: audioPath,
      type: 'AUDIO',
      createdAt: storedMessage.createdAt.toISOString(),
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


  @SubscribeMessage('call:invite')
  handleCallInvite(
    @MessageBody() payload: { kind?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    if (!room) {
      client.emit('call:error', 'Betritt zuerst einen Chatraum.');
      return;
    }

    const kind = payload?.kind;
    if (kind !== 'audio' && kind !== 'video') {
      client.emit('call:error', 'Ungültiger Anruftyp.');
      return;
    }

    const roomMembers = this.server.sockets.adapter.rooms.get(room) ?? new Set();
    const otherSockets = [...roomMembers]
      .filter((socketId) => socketId !== client.id)
      .map((socketId) => this.server.sockets.sockets.get(socketId))
      .filter(
        (peer): peer is Socket =>
          peer !== undefined && peer.data.userId !== client.data.userId,
      );

    const otherUserIds = new Set(otherSockets.map((peer) => peer.data.userId));

    if (otherUserIds.size !== 1) {
      client.emit('call:error', 'Es ist kein anderer Benutzer im Raum.');
      return;
    }

    if (client.data.activeCall || client.data.pendingCall) {
      client.emit('call:error', 'Du bist bereits in einem Anruf oder hast eine offene Einladung.');
      return;
    }

    const peer = otherSockets[0];
    if (peer.data.activeCall || peer.data.incomingCall || peer.data.pendingCall) {
      client.emit('call:error', 'Der andere Benutzer ist bereits in einem Anruf oder hat eine offene Einladung.');
      return;
    }

    const callId = client.id;
    client.data.pendingCall = {
      callId,
      peerSocketId: peer.id,
      kind,
    };
    peer.data.incomingCall = {
      callId,
      callerSocketId: client.id,
      callerUserId: client.data.userId,
      kind,
    };
    peer.emit('call:incoming', {
      callId,
      fromUserId: client.data.userId,
      fromName: client.data.user,
      kind,
    });
  }

  @SubscribeMessage('call:respond')
  handleCallResponse(
    @MessageBody() payload: { accepted?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const incomingCall = client.data.incomingCall;

    if (
      !room ||
      !incomingCall ||
      typeof payload?.accepted !== 'boolean'
    ) {
      client.emit('call:error', 'Keine gültige Anrufeinladung gefunden.');
      return;
    }

    const roomMembers = this.server.sockets.adapter.rooms.get(room) ?? new Set();
    if (!roomMembers.has(incomingCall.callerSocketId)) {
      delete client.data.incomingCall;
      client.emit('call:error', 'Der Anrufer ist nicht mehr verbunden.');
      return;
    }

    const caller = this.server.sockets.sockets.get(incomingCall.callerSocketId);
    if (
      !caller ||
      caller.data.room !== room ||
      caller.data.userId !== incomingCall.callerUserId ||
      caller.data.pendingCall?.callId !== incomingCall.callId
    ) {
      delete client.data.incomingCall;
      client.emit('call:error', 'Der Anrufer ist nicht mehr erreichbar.');
      return;
    }

    if (payload.accepted && (caller.data.activeCall || client.data.activeCall)) {
      client.emit('call:error', 'Ein Teilnehmer ist bereits in einem Anruf.');
      return;
    }

    if (payload.accepted) {
      caller.data.activeCall = {
        callId: incomingCall.callId,
        peerSocketId: client.id,
        kind: incomingCall.kind,
      };
      client.data.activeCall = {
        callId: incomingCall.callId,
        peerSocketId: caller.id,
        kind: incomingCall.kind,
      };
    }
    delete caller.data.pendingCall;

    caller.emit('call:response', {
      accepted: payload.accepted,
      callId: incomingCall.callId,
      kind: incomingCall.kind,
    });

    delete client.data.incomingCall;
  }

  @SubscribeMessage('call:signal')
  handleCallSignal(
    @MessageBody() payload: { callId?: unknown; signal?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ) {
    const room = client.data.room as string | undefined;
    const activeCall = client.data.activeCall;
    if (
      !room ||
      !activeCall ||
      !payload ||
      payload?.callId !== activeCall.callId ||
      typeof payload.signal !== 'object' ||
      payload.signal === null
    ) return;

    const peer = this.server.sockets.sockets.get(activeCall.peerSocketId);
    if (
      !peer ||
      peer.data.room !== room ||
      peer.data.activeCall?.callId !== activeCall.callId
    ) {
      delete client.data.activeCall;
      client.emit('call:ended', { callId: activeCall.callId, reason: 'peer-disconnected' });
      return;
    }

    peer.emit('call:signal', {
      callId: activeCall.callId,
      signal: payload.signal,
    });
  }

  @SubscribeMessage('call:end')
  handleCallEnd(
    @MessageBody() payload: { callId?: unknown } | undefined,
    @ConnectedSocket() client: Socket,
  ) {
    const activeCall = client.data.activeCall;
    if (!activeCall || payload?.callId !== activeCall.callId) return;

    const peer = this.server.sockets.sockets.get(activeCall.peerSocketId);
    delete client.data.activeCall;
    if (peer && peer.data.activeCall?.callId === activeCall.callId) {
      delete peer.data.activeCall;
      peer.emit('call:ended', { callId: activeCall.callId, reason: 'hangup' });
    }
  }
}
