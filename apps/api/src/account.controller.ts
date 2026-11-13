import {
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  UseGuards,
} from "@nestjs/common";
import { and, desc, eq, gt } from "drizzle-orm";
import { CurrentSession, SessionGuard, type UserSession } from "./auth/session.guard.js";
import { DatabaseService } from "./database/database.service.js";
import { session, user } from "./database/tables.schema.js";
import { OwnershipService } from "./ownership.js";

// Matches Better Auth's default `session.freshAge`: deletion needs a recent sign-in.
const FRESH_SESSION_MS = 24 * 60 * 60 * 1000;

@Controller("v1")
@UseGuards(SessionGuard)
export class AccountController {
  constructor(
    private readonly database: DatabaseService,
    private readonly ownership: OwnershipService,
  ) {}

  @Get("me")
  me(@CurrentSession() current: UserSession) {
    const { id, name, email, image, createdAt } = current.user;
    const role = current.user.role === "admin" ? "admin" : "user";
    return {
      user: { id, name, email, image, createdAt, role },
      role,
      session: { id: current.session.id, expiresAt: current.session.expiresAt },
    };
  }

  // Sessions, OAuth accounts and devices go with the user through ON DELETE CASCADE.
  @Delete("me")
  @HttpCode(204)
  async deleteAccount(@CurrentSession() current: UserSession) {
    if (Date.now() - current.session.createdAt.getTime() > FRESH_SESSION_MS) {
      throw new ForbiddenException("Sign in again to delete the account");
    }
    await this.database.db.transaction(async (tx) => {
      await tx.delete(user).where(eq(user.id, current.user.id));
    });
  }

  @Get("sessions")
  async sessions(@CurrentSession() current: UserSession) {
    const rows = await this.database.db
      .select()
      .from(session)
      .where(and(eq(session.userId, current.user.id), gt(session.expiresAt, new Date())))
      .orderBy(desc(session.updatedAt));
    return {
      sessions: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        expiresAt: row.expiresAt,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        current: row.id === current.session.id,
      })),
    };
  }

  @Delete("sessions/:id")
  @HttpCode(204)
  async revokeSession(@CurrentSession() current: UserSession, @Param("id") id: string) {
    await this.ownership.session(current.user.id, id);
    await this.database.db
      .delete(session)
      .where(and(eq(session.id, id), eq(session.userId, current.user.id)));
  }
}
