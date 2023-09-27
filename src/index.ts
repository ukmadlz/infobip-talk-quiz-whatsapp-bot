import Fastify from "fastify";
import FastifyPostgres from "@fastify/postgres";
import FastifyStatic from "@fastify/static";
import FastifySensible from "@fastify/sensible";
import S from "fluent-json-schema";
import { Infobip, AuthType } from "@infobip-api/sdk";
import * as Ably from "ably";
import Path from "path";
import "dotenv/config";

// Fastify & it's configuration
const fastify = Fastify({
  logger: true,
});
const connectionUrl = new URL(String(process.env.DATABASE_URL));
connectionUrl.search = "";
fastify.register(FastifyPostgres, {
  connectionString: connectionUrl.href,
  ssl: {
    rejectUnauthorized: false,
    ca: process.env.CA_PEM,
  },
});
fastify.register(FastifyStatic, {
  root: Path.join(__dirname, "../public"),
});
fastify.register(FastifySensible);

// Setup Infobip
const infobip = new Infobip({
  baseUrl: String(process.env.INFOBIP_BASE_URL),
  apiKey: String(process.env.INFOBIP_API_KEY),
  authType: AuthType.ApiKey,
});

// Setup Ably
const ablyOptions: Ably.Types.ClientOptions = { key: process.env.ABLY_API_KEY };
let ably = new Ably.Rest.Promise(ablyOptions);

// Routes
fastify.post(
  "/message/inbound",
  { schema: { body: S.object().prop("results", S.array()) } },
  async (request: any, reply) => {
    const { results } = request.body;
    try {
      await results.forEach(async (whatsappMessage: any) => {
        const { messageId, from, to } = whatsappMessage;
        const newUserData = await fastify.pg.query(
          "INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING RETURNING id;",
          [from],
        );
        if (newUserData.rows.length > 0) {
          await infobip.channels.whatsapp.send({
            type: "text",
            from: String(process.env.INFOBIP_WHATSAPP_SENDER),
            to: from,
            content: {
              text: "Thanks for joining 😄 let's have some fun",
            },
          });
          await infobip.channels.whatsapp.send({
            type: "image",
            from: String(process.env.INFOBIP_WHATSAPP_SENDER),
            to: from,
            content: {
              mediaUrl:
                "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcT2Y2aFqUbRHfMnxOthwedrzyeXGXjLhUIy-A&usqp=CAU",
            },
          });
        }
        if (whatsappMessage.message.type === "INTERACTIVE_BUTTON_REPLY") {
          const channel = await ably.channels.get("you-should-write-an-sdk");
          const userData = await fastify.pg.query(
            "SELECT id FROM users WHERE phone = $1",
            [from],
          );
          const userId = userData.rows[0].id;
          const answerId = Number(whatsappMessage.message.id);
          const questionData = await fastify.pg.query(
            "SELECT question_id FROM answers WHERE id = $1",
            [answerId],
          );
          const questionId = questionData.rows[0].question_id;
          await fastify.pg.query(
            "INSERT INTO user_answers (user_id, question_id, answer_id) VALUES ($1, $2, $3) ON CONFLICT (user_id, question_id) DO UPDATE SET answer_id = $3",
            [userId, questionId, answerId],
          );
          channel.publish(
            "answer",
            JSON.stringify({
              userId,
              answerId,
              questionId,
            }),
          );
        }
        infobip.channels.whatsapp.markAsRead(to, messageId);
        await infobip.channels.whatsapp.send({
          type: "text",
          from: String(process.env.INFOBIP_WHATSAPP_SENDER),
          to: from,
          content: {
            text: "Wait for the questions to come in",
          },
        });
      });
      return { hello: "world" };
    } catch (error) {
      return error;
    }
  },
);
fastify.get(
  "/message/question/:questionId",
  { schema: { params: S.object().prop("questionId", S.integer()) } },
  async (request: any, reply) => {
    const { questionId } = request.params;
    const usersData = await fastify.pg.query("SELECT phone FROM users");
    const questionData = await fastify.pg.query(
      "SELECT question FROM questions WHERE id = $1",
      [questionId],
    );
    const answerData = await fastify.pg.query(
      "SELECT id, answer FROM answers WHERE question_id = $1",
      [questionId],
    );
    const answers = answerData.rows.map((answer: any) => {
      return {
        type: "REPLY",
        id: String(answer.id),
        title: answer.answer,
      };
    });
    await usersData.rows.map(async (user: any) => {
      const { phone } = user;
      const response = await infobip.channels.whatsapp.send({
        type: "interactive-buttons",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          body: {
            text: questionData.rows[0].question,
          },
          action: {
            buttons: answers,
          },
        },
      });
    });
    return {
      question: questionId,
      answers,
    };
  },
);

fastify.get("/message/coupons", async (request: any, reply) => {
  const usersData = await fastify.pg.query("SELECT id, phone FROM users");
  const couponsData = await fastify.pg.query("SELECT id, coupon FROM coupons");

  const coupons = await couponsData.rows.map(async (coupon: any) => {
    return coupon;
  });
  await usersData.rows.map(async (user: any) => {
    if (coupons.length) {
      const { id, phone } = user;
      const coupon = await coupons.pop();
      console.log({
        coupon,
        phone
      })
      await infobip.channels.whatsapp.send({
        type: "text",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          text: "SORRY! I goofed, here is the correct links & the coupon code",
        },
      });
      await infobip.channels.whatsapp.send({
        type: "text",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          text: "Your €20 coupon code to use on the infobip platform is valid for 14 days. To register an account head to https://r.elsmore.me/3rsyW38, and apply the following code in the referrals section in the bottom left:",
        },
      });
      await infobip.channels.whatsapp.send({
        type: "text",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          text: coupon.coupon,
        },
      });
      await fastify.pg.query("UPDATE coupons SET user_id = $1 WHERE id = $2", [
        id,
        coupon.id,
      ]);
      await infobip.channels.whatsapp.send({
        type: "text",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          text: "Any questions, need help, or just want to chat head to our discord at https://discord.com/invite/G9Gr6fk2e4",
        },
      });
      await infobip.channels.whatsapp.send({
        type: "text",
        from: String(process.env.INFOBIP_WHATSAPP_SENDER),
        to: phone,
        content: {
          text: "And for those that care, my slide https://r.elsmore.me/3LD7iHK",
        },
      });
    }
  });
});

fastify.get("/", async (request, reply) => {
  const questionData = await fastify.pg.query(
    "SELECT id, question FROM questions ORDER BY id",
  );
  const questions = await questionData.rows.map((question: any) => {
    return `<li style="font-size: 3em;" ><a href="/message/question/${question.id}" target="_blank">${question.question}</a></li>`;
  });
  await questions.push(
    `<li style="font-size: 3em;"><a href="/message/coupons" target="_blank">Coupons</a></li>`,
  );
  return reply
    .type("text/html")
    .send(
      `<html><head><title>Commands</title></head><body><ul>${questions.join(
        "",
      )}</ul></body></html>`,
    );
});

// Run the server
const start = async () => {
  try {
    const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
    const HOST = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
