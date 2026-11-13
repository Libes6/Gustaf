import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { readPage } from "../admin/admin-rules.js";
import { AdminGuard } from "../admin/admin.guard.js";
import { CurrentSession, SessionGuard, type UserSession } from "../auth/session.guard.js";
import { readReportInput, readReportStatus, readReportUpdate } from "./report-rules.js";
import { ReportsService } from "./reports.service.js";

// The apps send reports with the account session they already hold (desktop shell, mobile).
@Controller("v1/reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @UseGuards(SessionGuard)
  create(@CurrentSession() { user }: UserSession, @Body() body: unknown) {
    return this.reports.create(user.id, readReportInput(body));
  }
}

@Controller("v1/admin/reports")
@UseGuards(AdminGuard)
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  list(@Query() query: { limit?: unknown; cursor?: unknown; status?: unknown }) {
    return this.reports.list(readReportStatus(query.status), readPage(query));
  }

  @Get("counts")
  counts() {
    return this.reports.counts();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.reports.get(id);
  }

  @Patch(":id")
  @HttpCode(204)
  async update(
    @CurrentSession() { user }: UserSession,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.reports.update(user.id, id, readReportUpdate(body));
  }
}
