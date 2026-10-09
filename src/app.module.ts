import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ChatModule } from './chat/chat.module.js';
import { PrismaModule } from './database/prisma.module.js';

@Module({
  imports: [ChatModule, PrismaModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
