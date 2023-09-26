import Fastify from "fastify";
import FastifyPostgres from "@fastify/postgres";
import FastifyStatic from "@fastify/static";
import FastifySensible from "@fastify/sensible";
import S from "fluent-json-schema";
import { Infobip, AuthType } from "@infobip-api/sdk";
import Path from "path";
import "dotenv/config";

// Fastify & it's configuration
const fastify = Fastify({
  logger: true,
});
fastify.register(FastifyPostgres, {
  connectionString: process.env.DATABASE_URL,
  ssl: {
      rejectUnauthorized: true,
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
              mediaUrl: "https://a729-92-87-237-3.ngrok-free.app/public/images/looking-forward-to-having-some-fun-with-this.gif",
            },
          });
        }
        if (whatsappMessage.message.type === "INTERACTIVE_BUTTON_REPLY") {
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
        }
        infobip.channels.whatsapp.markAsRead(to, messageId);
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

// Run the server
const start = async () => {
  try {
    const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
    const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1';
    await fastify.listen({ port: PORT, host: HOST });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
