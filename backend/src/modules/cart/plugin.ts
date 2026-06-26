import fp from "fastify-plugin";
import type { FastifyPluginAsync, RouteHandlerMethod } from "fastify";
import {
  getGuestCartItems,
  getOrCreateGuestCartContext
} from "./guest-session.js";

const cartPlugin: FastifyPluginAsync = async (fastify) => {
  const getCart: RouteHandlerMethod = async (request, reply) => {
    if (request.auth) {
      return {
        items: []
      };
    }

    const guestCart = await getOrCreateGuestCartContext(request, reply);
    const items = await getGuestCartItems(fastify.redis, guestCart.cartId);

    return {
      cartId: guestCart.cartId,
      items
    };
  };

  fastify.get("/", getCart);
};

export default fp(cartPlugin, {
  name: "cart-module"
});
