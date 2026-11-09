import express from "express";
import { PspSimulator } from "./modules/payment/psp/psp-simulator";
import { config } from "./modules/common/config";

const app = express();
const simulator = new PspSimulator();
const port = config.PSP_PORT ?? 3001;

app.use(express.json());

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", service: "psp-simulator" });
});

app.post("/psp/authorize", async (req, res) => {
  try {
    const response = await simulator.authorize({
      ourReference: req.body.ourReference,
      amount: String(req.body.amount ?? "0"),
      currency: req.body.currency ?? "USD",
      cardNumber: req.body.cardNumber ?? "4111111111111111",
      faultMode: req.body.faultMode,
    });
    res.status(200).json(response);
  } catch (error) {
    res.status(502).json({
      code: "PSP_TIMEOUT",
      message: error instanceof Error ? error.message : "Unknown PSP error",
    });
  }
});

app.post("/psp/capture", async (req, res) => {
  try {
    const response = await simulator.capture({
      pspReference: req.body.pspReference,
      amount: String(req.body.amount ?? "0"),
    });
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({
      code: "CAPTURE_FAILED",
      message: error instanceof Error ? error.message : "Capture failed",
    });
  }
});

app.post("/psp/void", async (req, res) => {
  try {
    const response = await simulator.void({ pspReference: req.body.pspReference });
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({
      code: "VOID_FAILED",
      message: error instanceof Error ? error.message : "Void failed",
    });
  }
});

app.post("/psp/refund", async (req, res) => {
  try {
    const response = await simulator.refund({
      pspReference: req.body.pspReference,
      amount: String(req.body.amount ?? "0"),
    });
    res.status(200).json(response);
  } catch (error) {
    res.status(400).json({
      code: "REFUND_FAILED",
      message: error instanceof Error ? error.message : "Refund failed",
    });
  }
});

app.get("/psp/status/:ourReference", async (req, res) => {
  const status = await simulator.statusInquiry(req.params.ourReference);
  if (!status) {
    return res.status(404).json({ code: "NOT_FOUND", message: "Reference not found" });
  }
  return res.status(200).json(status);
});

app.listen(port, () => {
  console.log(`PSP simulator listening on http://localhost:${port}`);
});
