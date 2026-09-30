import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import Joi from "joi";
import { authMiddleware, requireRole } from "../auth/index.js";
import {
  SalesAnalyticsRepository,
  type SalesAnalyticsReader
} from "./repository.js";
import type { SalesAnalyticsQuery } from "./types.js";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maximumRangeDays = 366;

function validTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const querySchema = Joi.object({
  bestSellerLimit: Joi.number().integer().min(1).max(50).default(10),
  bucket: Joi.string().valid("day", "week", "month").default("day"),
  currency: Joi.string().trim().lowercase().pattern(/^[a-z]{3}$/).required(),
  endDate: Joi.string().pattern(datePattern).required(),
  startDate: Joi.string().pattern(datePattern).required(),
  timezone: Joi.string()
    .trim()
    .max(100)
    .custom((value: string, helpers) =>
      validTimeZone(value) ? value : helpers.error("any.invalid"),
    )
    .required()
}).required();

function calendarDayNumber(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day));

  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day
  ) {
    return null;
  }

  return Math.floor(instant.getTime() / 86_400_000);
}

function validateRange(query: SalesAnalyticsQuery) {
  const start = calendarDayNumber(query.startDate);
  const end = calendarDayNumber(query.endDate);

  if (start === null || end === null) {
    return "startDate and endDate must be real calendar dates.";
  }
  if (end < start) {
    return "endDate must be on or after startDate.";
  }
  if (end - start + 1 > maximumRangeDays) {
    return `Date ranges cannot exceed ${maximumRangeDays} inclusive days.`;
  }

  return null;
}

function validationError(reply: FastifyReply, message: string) {
  return reply.code(400).send({
    error: "VALIDATION_ERROR",
    message,
    statusCode: 400
  });
}

export type AdminAnalyticsPluginDependencies = {
  reader?: SalesAnalyticsReader;
};

export function createAdminAnalyticsPlugin(
  dependencies: AdminAnalyticsPluginDependencies = {},
) {
  const plugin: FastifyPluginAsync = async (fastify) => {
    const reader = dependencies.reader ?? new SalesAnalyticsRepository(fastify.pg);

    fastify.get(
      "/sales",
      {
        preHandler: [authMiddleware, requireRole("admin")]
      },
      async (request, reply) => {
        const { error, value } = querySchema.validate(request.query, {
          abortEarly: false,
          allowUnknown: false,
          stripUnknown: false
        });

        if (error) {
          return validationError(reply, error.message);
        }

        const query = value as SalesAnalyticsQuery;
        const rangeError = validateRange(query);
        if (rangeError) {
          return validationError(reply, rangeError);
        }

        const report = await reader.getSalesReport(query);
        request.log.info(
          {
            bucket: query.bucket,
            currency: query.currency,
            endDate: query.endDate,
            event: "admin.analytics.sales.completed",
            paidOrderCount: report.metrics.paidOrderCount,
            startDate: query.startDate,
            timezone: query.timezone
          },
          "Admin sales analytics completed",
        );
        return report;
      },
    );
  };

  return fp(plugin, {
    encapsulate: true,
    name: "admin-analytics-plugin"
  });
}

export default createAdminAnalyticsPlugin();
