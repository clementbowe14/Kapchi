import { randomUUID } from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import Joi from "joi";
import { config } from "../../config/index.js";
import { getDatabasePool } from "../../database/index.js";
import { authMiddleware } from "../auth/index.js";
import { getGuestCartContext, hashSessionId } from "../cart/guest-session.js";

type AssetContext = "customization_image" | "catalog_listing_image" | "fabric_image";
type AssetVisibility = "private" | "public_catalog";

type AssetRow = {
  byte_size: number;
  checksum: string | null;
  content_type: string;
  context: AssetContext;
  id: string;
  provider: string;
  status: string;
  storage_key: string | null;
  url: string | null;
  visibility: AssetVisibility;
};

type PendingAssetRow = AssetRow & {
  authenticated_user_id: string | null;
  cart_id: string | null;
  created_by_auth_subject: string | null;
  expected_pathname: string | null;
  fabric_id: string | null;
  listing_customization_set_id: string | null;
  listing_id: string | null;
};

type UploadIntentBody = {
  byteSize: number;
  cartId?: string;
  contentType: string;
  context: AssetContext;
  customizationSetId?: string;
  fabricId?: string;
  filename: string;
  listingId?: string;
  visibility?: AssetVisibility;
};

type UploadPayload = UploadIntentBody & {
  assetId: string;
  issuedAt: string;
};

type BlobCompletion = {
  contentType?: string;
  downloadUrl?: string;
  etag?: string;
  pathname?: string;
  size?: number;
  url: string;
};

const adminContexts = new Set<AssetContext>([
  "catalog_listing_image",
  "fabric_image"
]);

const intentSchema = Joi.object<UploadIntentBody>({
  byteSize: Joi.number().integer().min(1).required(),
  cartId: Joi.string().guid().optional(),
  contentType: Joi.string()
    .valid(...config.assets.allowedImageContentTypes)
    .required(),
  context: Joi.string()
    .valid("customization_image", "catalog_listing_image", "fabric_image")
    .required(),
  customizationSetId: Joi.string().guid().optional(),
  fabricId: Joi.string().guid().optional(),
  filename: Joi.string().trim().min(1).max(255).required(),
  listingId: Joi.string().guid().optional(),
  visibility: Joi.string().valid("private", "public_catalog").optional()
}).required();

const payloadSchema = intentSchema.concat(
  Joi.object({
    assetId: Joi.string().guid().required(),
    issuedAt: Joi.string().isoDate().required()
  }),
);

const tokenAuthorizationSchema = Joi.object({
  clientPayload: Joi.alternatives().try(Joi.string(), Joi.object()).required(),
  pathname: Joi.string().trim().min(1).max(255).required()
}).required();

const completionSchema = Joi.object({
  blob: Joi.object({
    contentType: Joi.string().optional(),
    downloadUrl: Joi.string().uri().optional(),
    etag: Joi.string().optional(),
    pathname: Joi.string().optional(),
    size: Joi.number().integer().min(0).optional(),
    url: Joi.string().uri({ scheme: ["http", "https"] }).required()
  }).required(),
  tokenPayload: Joi.alternatives().try(Joi.string(), Joi.object()).required()
}).required();

function requestError(reply: FastifyReply, statusCode: number, error: string, message: string) {
  return reply.code(statusCode).send({
    error,
    message,
    statusCode
  });
}

function isAdmin(request: FastifyRequest) {
  const roles = request.auth?.roles ?? [];
  const permissions = request.auth?.permissions ?? [];

  return (
    roles.includes("admin") ||
    permissions.includes("assets:write") ||
    permissions.includes("catalog:write") ||
    permissions.includes("listings:write") ||
    permissions.includes("fabrics:write")
  );
}

function sanitizeFilename(filename: string) {
  const normalized = filename
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "upload";
}

function defaultVisibility(context: AssetContext, requested?: AssetVisibility): AssetVisibility {
  if (context === "customization_image") {
    return "private";
  }

  return requested ?? "public_catalog";
}

function safeAsset(row: AssetRow) {
  return {
    byteSize: row.byte_size,
    checksum: row.checksum,
    contentType: row.content_type,
    context: row.context,
    id: row.id,
    provider: row.provider,
    status: row.status,
    storageKey: row.storage_key,
    url: row.visibility === "public_catalog" ? row.url : null,
    visibility: row.visibility
  };
}

function parsePayload(value: unknown): UploadPayload {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const { error, value: payload } = payloadSchema.validate(parsed, {
    abortEarly: false,
    stripUnknown: true
  });

  if (error) {
    throw error;
  }

  return payload as UploadPayload;
}

function storageKeyFromBlob(blob: BlobCompletion) {
  if (blob.pathname?.trim()) {
    return blob.pathname.trim();
  }

  return new URL(blob.url).pathname.replace(/^\/+/, "");
}

function buildPathname(context: AssetContext, assetId: string, filename: string) {
  return ["kapchi", context, assetId, sanitizeFilename(filename)].join("/");
}

function assertConfiguredCallbackSecret(request: FastifyRequest, reply: FastifyReply) {
  const expectedSecret = config.assets.uploadCallbackSecret;

  if (!expectedSecret) {
    void requestError(
      reply,
      503,
      "UPLOAD_CALLBACK_SECRET_NOT_CONFIGURED",
      "Upload completion callback secret is not configured.",
    );
    return false;
  }

  if (request.headers["x-kapchi-upload-callback-secret"] !== expectedSecret) {
    void requestError(
      reply,
      401,
      "UNAUTHORIZED",
      "Upload completion callback is not authorized.",
    );
    return false;
  }

  return true;
}

async function findInternalUserId(authSubject: string | undefined) {
  if (!authSubject) {
    return null;
  }

  const result = await getDatabasePool().query<{ id: string }>(
    `
      select id
      from users
      where auth_provider = 'clerk'
        and auth_subject = $1
      limit 1
    `,
    [authSubject],
  );

  return result.rows[0]?.id ?? null;
}

async function validateImageCustomization(listingId: string, customizationSetId: string) {
  const result = await getDatabasePool().query<{
    enabled: boolean;
    image_max_bytes: number | null;
    listing_status: string;
    listing_type: string;
    requires_image: boolean;
  }>(
    `
      select
        l.status as listing_status,
        l.listing_type,
        lcs.enabled,
        lcs.image_max_bytes,
        cs.requires_image
      from listings l
      join listing_customization_sets lcs on lcs.listing_id = l.id
      join customization_sets cs on cs.id = lcs.customization_set_id
      where l.id = $1
        and lcs.id = $2
      limit 1
    `,
    [listingId, customizationSetId],
  );
  const row = result.rows[0];

  if (!row) {
    return "Unknown listing customization.";
  }

  if (row.listing_status !== "active" || row.listing_type !== "graduation_stole") {
    return "Customer images are only accepted for active graduation stoles.";
  }

  if (!row.enabled || !row.requires_image) {
    return "This customization does not accept image uploads.";
  }

  return null;
}

async function validateCartContainsCustomization(
  cartId: string,
  listingId: string,
  customizationSetId: string,
) {
  const result = await getDatabasePool().query<{ id: string }>(
    `
      select id
      from cart_items
      where cart_id = $1
        and listing_id = $2
        and listing_customization_set_id = $3
        and validation_status = 'valid'
      limit 1
    `,
    [cartId, listingId, customizationSetId],
  );

  return Boolean(result.rows[0]);
}

async function authorizeCustomerUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  body: UploadIntentBody,
) {
  if (!body.cartId || !body.listingId || !body.customizationSetId) {
    return requestError(
      reply,
      400,
      "VALIDATION_ERROR",
      "Customization image uploads require cartId, listingId, and customizationSetId.",
    );
  }

  const customizationError = await validateImageCustomization(
    body.listingId,
    body.customizationSetId,
  );

  if (customizationError) {
    return requestError(reply, 400, "VALIDATION_ERROR", customizationError);
  }

  if (request.auth) {
    const internalUserId = await findInternalUserId(request.auth.userId);
    const cartResult = await getDatabasePool().query<{ id: string }>(
      `
        select id
        from carts
        where id = $1
          and status = 'active'
          and (
            user_id = $2
            or ($3::uuid is not null and authenticated_user_id = $3::uuid)
          )
        limit 1
      `,
      [body.cartId, request.auth.userId, internalUserId],
    );

    if (!cartResult.rows[0]) {
      return requestError(
        reply,
        403,
        "FORBIDDEN",
        "The requested cart is not available for this customer.",
      );
    }

    if (
      !(await validateCartContainsCustomization(
        body.cartId,
        body.listingId,
        body.customizationSetId,
      ))
    ) {
      return requestError(
        reply,
        403,
        "FORBIDDEN",
        "Customization image uploads require the selected stole customization to be in the active cart.",
      );
    }

    return {
      authenticatedUserId: internalUserId,
      cartId: body.cartId,
      createdByAuthSubject: request.auth.userId
    };
  }

  const guestCart = await getGuestCartContext(request);

  if (!guestCart || guestCart.cartId !== body.cartId) {
    return requestError(
      reply,
      403,
      "FORBIDDEN",
      "A matching guest cart session is required for customization uploads.",
    );
  }

  const guestTokenHash = hashSessionId(guestCart.sessionId);

  await getDatabasePool().query(
    `
      insert into carts (id, guest_token_hash, status, currency)
      values ($1, $2, 'active', 'usd')
      on conflict (id) do nothing
    `,
    [guestCart.cartId, guestTokenHash],
  );

  const cartResult = await getDatabasePool().query<{ id: string }>(
    `
      select id
      from carts
      where id = $1
        and status = 'active'
        and guest_token_hash = $2
      limit 1
    `,
    [guestCart.cartId, guestTokenHash],
  );

  if (!cartResult.rows[0]) {
    return requestError(
      reply,
      403,
      "FORBIDDEN",
      "The requested guest cart is not available for this session.",
    );
  }

  if (
    !(await validateCartContainsCustomization(
      body.cartId,
      body.listingId,
      body.customizationSetId,
    ))
  ) {
    return requestError(
      reply,
      403,
      "FORBIDDEN",
      "Customization image uploads require the selected stole customization to be in the active cart.",
    );
  }

  return {
    authenticatedUserId: null,
    cartId: guestCart.cartId,
    createdByAuthSubject: null
  };
}

async function authorizeAdminUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  body: UploadIntentBody,
) {
  if (!request.auth || !isAdmin(request)) {
    return requestError(
      reply,
      403,
      "FORBIDDEN",
      "Admin access is required for catalog and fabric asset uploads.",
    );
  }

  if (body.context === "catalog_listing_image" && !body.listingId) {
    return requestError(
      reply,
      400,
      "VALIDATION_ERROR",
      "Listing catalog image uploads require listingId.",
    );
  }

  if (body.context === "fabric_image" && !body.fabricId) {
    return requestError(
      reply,
      400,
      "VALIDATION_ERROR",
      "Fabric image uploads require fabricId.",
    );
  }

  const internalUserId = await findInternalUserId(request.auth.userId);

  return {
    authenticatedUserId: internalUserId,
    cartId: null,
    createdByAuthSubject: request.auth.userId
  };
}

async function authorizeUpload(
  request: FastifyRequest,
  reply: FastifyReply,
  body: UploadIntentBody,
) {
  if (body.byteSize > config.assets.maxImageBytes) {
    return requestError(
      reply,
      400,
      "VALIDATION_ERROR",
      `Image uploads must be ${config.assets.maxImageBytes} bytes or smaller.`,
    );
  }

  if (adminContexts.has(body.context)) {
    return authorizeAdminUpload(request, reply, body);
  }

  return authorizeCustomerUpload(request, reply, body);
}

function buildTokenPayload(body: UploadIntentBody, assetId: string): UploadPayload {
  const visibility = defaultVisibility(body.context, body.visibility);

  return {
    ...body,
    assetId,
    issuedAt: new Date().toISOString(),
    visibility
  };
}

async function createPendingAsset(
  body: UploadIntentBody,
  authorization: {
    authenticatedUserId: string | null;
    cartId: string | null;
    createdByAuthSubject: string | null;
  },
  assetId: string,
  pathname: string,
) {
  const visibility = defaultVisibility(body.context, body.visibility);
  const result = await getDatabasePool().query<AssetRow>(
    `
      insert into assets (
        id,
        provider,
        content_type,
        byte_size,
        visibility,
        context,
        status,
        authenticated_user_id,
        created_by_auth_subject,
        cart_id,
        listing_id,
        listing_customization_set_id,
        fabric_id,
        metadata
      ) values ($1, 'vercel_blob', $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11, $12)
      returning id, provider, storage_key, url, content_type, byte_size, checksum, visibility, context, status
    `,
    [
      assetId,
      body.contentType,
      body.byteSize,
      visibility,
      body.context,
      authorization.authenticatedUserId,
      authorization.createdByAuthSubject,
      authorization.cartId,
      body.listingId ?? null,
      body.customizationSetId ?? null,
      body.fabricId ?? null,
      JSON.stringify({
        expectedPathname: pathname,
        originalFilename: body.filename,
        source: "vercel_blob_client_upload_intent"
      })
    ],
  );

  return result.rows[0];
}

async function findPendingAsset(assetId: string) {
  const result = await getDatabasePool().query<PendingAssetRow>(
    `
      select
        id,
        provider,
        storage_key,
        url,
        content_type,
        byte_size,
        checksum,
        visibility,
        context,
        status,
        authenticated_user_id,
        created_by_auth_subject,
        cart_id,
        listing_id,
        listing_customization_set_id,
        fabric_id,
        metadata->>'expectedPathname' as expected_pathname
      from assets
      where id = $1
      limit 1
    `,
    [assetId],
  );

  return result.rows[0] ?? null;
}

function nullish(value: string | undefined) {
  return value ?? null;
}

function validatePendingAssetMatchesPayload(
  asset: PendingAssetRow | null,
  payload: UploadPayload,
  authorization?: {
    authenticatedUserId: string | null;
    cartId: string | null;
    createdByAuthSubject: string | null;
  },
) {
  if (!asset) {
    return "Upload asset not found.";
  }

  if (asset.provider !== "vercel_blob" || asset.status !== "pending") {
    return "Upload asset is not pending Vercel Blob finalization.";
  }

  if (!asset.expected_pathname) {
    return "Upload asset is missing its expected Blob pathname.";
  }

  const mismatches = [
    asset.content_type !== payload.contentType,
    asset.byte_size !== payload.byteSize,
    asset.context !== payload.context,
    asset.visibility !== payload.visibility,
    asset.cart_id !== nullish(payload.cartId),
    asset.listing_id !== nullish(payload.listingId),
    asset.listing_customization_set_id !== nullish(payload.customizationSetId),
    asset.fabric_id !== nullish(payload.fabricId)
  ];

  if (mismatches.some(Boolean)) {
    return "Upload token payload does not match the pending asset record.";
  }

  if (
    authorization &&
    (asset.authenticated_user_id !== authorization.authenticatedUserId ||
      asset.cart_id !== authorization.cartId ||
      asset.created_by_auth_subject !== authorization.createdByAuthSubject)
  ) {
    return "Upload token caller does not match the pending asset owner.";
  }

  return null;
}

const assetsPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    "/upload-intents",
    {
      preHandler: [authMiddleware]
    },
    async (request, reply) => {
      const { error, value } = intentSchema.validate(request.body, {
        abortEarly: false,
        stripUnknown: true
      });

      if (error) {
        return requestError(reply, 400, "VALIDATION_ERROR", error.message);
      }

      const body = value as UploadIntentBody;
      const authorization = await authorizeUpload(request, reply, body);

      if (!authorization || "statusCode" in authorization) {
        return authorization;
      }

      const assetId = randomUUID();
      const pathname = buildPathname(body.context, assetId, body.filename);
      const asset = await createPendingAsset(
        body,
        authorization,
        assetId,
        pathname,
      );
      const payload = buildTokenPayload(body, asset.id);

      return {
        access: payload.visibility === "public_catalog" ? "public" : "private",
        allowedContentTypes: config.assets.allowedImageContentTypes,
        asset: safeAsset(asset),
        assetId: asset.id,
        clientPayload: JSON.stringify(payload),
        maxBytes: config.assets.maxImageBytes,
        pathname
      };
    },
  );

  fastify.post(
    "/upload-token-authorizations",
    {
      preHandler: [authMiddleware]
    },
    async (request, reply) => {
      const { error, value } = tokenAuthorizationSchema.validate(request.body, {
        abortEarly: false,
        stripUnknown: true
      });

      if (error) {
        return requestError(reply, 400, "VALIDATION_ERROR", error.message);
      }

      const body = value as { clientPayload: unknown; pathname: string };
      let payload: UploadPayload;

      try {
        payload = parsePayload(body.clientPayload);
      } catch (parseError) {
        const message =
          parseError instanceof Error
            ? parseError.message
            : "Upload token payload is invalid.";
        return requestError(reply, 400, "VALIDATION_ERROR", message);
      }

      const authorization = await authorizeUpload(request, reply, payload);

      if (!authorization || "statusCode" in authorization) {
        return authorization;
      }

      const pendingAsset = await findPendingAsset(payload.assetId);
      const pendingAssetError = validatePendingAssetMatchesPayload(
        pendingAsset,
        payload,
        authorization,
      );

      if (pendingAssetError) {
        return requestError(reply, 400, "VALIDATION_ERROR", pendingAssetError);
      }

      if (pendingAsset?.expected_pathname !== body.pathname) {
        return requestError(
          reply,
          400,
          "VALIDATION_ERROR",
          "Upload pathname does not match the pending asset record.",
        );
      }

      return {
        access: payload.visibility === "public_catalog" ? "public" : "private",
        addRandomSuffix: false,
        allowedContentTypes: config.assets.allowedImageContentTypes,
        maximumSizeInBytes: config.assets.maxImageBytes,
        tokenPayload: JSON.stringify(payload)
      };
    },
  );

  fastify.post("/upload-completions", async (request, reply) => {
    if (!assertConfiguredCallbackSecret(request, reply)) {
      return;
    }

    const { error, value } = completionSchema.validate(request.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      return requestError(reply, 400, "VALIDATION_ERROR", error.message);
    }

    const body = value as { blob: BlobCompletion; tokenPayload: unknown };
    let payload: UploadPayload;

    try {
      payload = parsePayload(body.tokenPayload);
    } catch (parseError) {
      const message =
        parseError instanceof Error
          ? parseError.message
          : "Upload completion payload is invalid.";
      return requestError(reply, 400, "VALIDATION_ERROR", message);
    }

    const pendingAsset = await findPendingAsset(payload.assetId);
    const pendingAssetError = validatePendingAssetMatchesPayload(
      pendingAsset,
      payload,
    );

    if (pendingAssetError) {
      const statusCode = pendingAsset ? 400 : 404;
      const errorCode = pendingAsset ? "VALIDATION_ERROR" : "ASSET_NOT_FOUND";
      return requestError(reply, statusCode, errorCode, pendingAssetError);
    }

    const blobContentType = body.blob.contentType ?? payload.contentType;
    const blobSize = body.blob.size ?? payload.byteSize;
    const storageKey = storageKeyFromBlob(body.blob);

    if (!config.assets.allowedImageContentTypes.includes(blobContentType)) {
      return requestError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Completed upload has an unsupported content type.",
      );
    }

    if (blobSize > config.assets.maxImageBytes) {
      return requestError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Completed upload exceeds the configured image size limit.",
      );
    }

    if (blobContentType !== payload.contentType || blobSize !== payload.byteSize) {
      return requestError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Completed upload metadata does not match the pending asset record.",
      );
    }

    if (pendingAsset?.expected_pathname !== storageKey) {
      return requestError(
        reply,
        400,
        "VALIDATION_ERROR",
        "Completed upload pathname does not match the pending asset record.",
      );
    }

    const result = await getDatabasePool().query<AssetRow>(
      `
        update assets
        set
          provider = 'vercel_blob',
          storage_key = $2,
          url = $3,
          content_type = $4,
          byte_size = $5,
          checksum = $6,
          visibility = $7,
          status = 'uploaded',
          metadata = metadata || $8::jsonb
        where id = $1
          and status = 'pending'
        returning id, provider, storage_key, url, content_type, byte_size, checksum, visibility, context, status
      `,
      [
        payload.assetId,
        storageKey,
        body.blob.url,
        blobContentType,
        blobSize,
        body.blob.etag ?? null,
        payload.visibility,
        JSON.stringify({
          completedBy: "vercel_blob_callback",
          downloadUrl: body.blob.downloadUrl ?? null
        })
      ],
    );

    const asset = result.rows[0];

    if (!asset) {
      return requestError(reply, 404, "ASSET_NOT_FOUND", "Upload asset not found.");
    }

    return {
      asset: safeAsset(asset),
      assetId: asset.id
    };
  });
};

export default fp(assetsPlugin, {
  name: "assets-module"
});
