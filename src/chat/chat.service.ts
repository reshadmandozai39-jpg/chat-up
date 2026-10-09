import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class ChatService {
	constructor(private readonly prisma: PrismaService) {}

	async getOrCreateMockUser(name: string, email?: string) {
		const normalizedName = name.trim() || 'Unbekannt';
		const username = normalizedName
			.normalize('NFKD')
			.replace(/[\u0300-\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9_-]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'mock-user';
		const [firstName, ...lastNameParts] = normalizedName.split(/\s+/);
		const lastName = lastNameParts.join(' ') || 'Mock';

		return this.prisma.user.upsert({
			where: { username },
			create: {
				email: email?.trim().toLowerCase() || `${username}@mock.chat-up.local`,
				username: username,
				firstName: firstName,
				LastName: lastName,
				status: 'ONLINE',
			},
			update: {
				firstName: firstName,
				LastName: lastName,
				status: 'ONLINE',
			},
		});
	}

	async getOrCreateChatRoom(name: string) {
		return this.prisma.chatRoom.upsert({
			where: { name },
			create: { name },
			update: {},
		});
	}

	async saveMessage(senderId: number, chatRoomId: number, content: string) {
		return this.prisma.message.create({
			data: { senderId, chatRoomId, content },
		});
	}

	async getRecentMessages(chatRoomId: number) {
		const messages = await this.prisma.message.findMany({
			where: { chatRoomId },
			orderBy: { createdAt: 'desc' },
			take: 50,
			include: {
				sender: {
					select: { id: true, firstName: true, LastName: true },
				},
			},
		});

		return messages.reverse();
	}
}
