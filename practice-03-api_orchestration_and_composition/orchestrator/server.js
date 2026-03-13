const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  return {
    port: Number(process.env.ORCHESTRATOR_PORT || 3000),
    paymentUrl: readRequiredEnv('PAYMENT_URL'),
    inventoryUrl: readRequiredEnv('INVENTORY_URL'),
    shippingUrl: readRequiredEnv('SHIPPING_URL'),
    notificationUrl: readRequiredEnv('NOTIFICATION_URL'),
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 2500)
  };
}

const config = loadConfig();

const DATA_DIR = '/data';
const IDEMPOTENCY_STORE_PATH = path.join(DATA_DIR, 'idempotency-store.json');
const SAGA_STORE_PATH = path.join(DATA_DIR, 'saga-store.json');

function ensureJsonFile(filePath, initialData) {
  const dirPath = path.dirname(filePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function readJsonFile(filePath) {
  ensureJsonFile(filePath, {});
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw || '{}');
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function nowIso() {
  return new Date().toISOString();
}

function payloadHash(payload) {
  const normalized = JSON.stringify(payload);
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  return `sha256:${hash}`;
}

function validateCheckoutPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return 'Request body must be a JSON object';
  }
  if (typeof payload.orderId !== 'string' || payload.orderId.trim() === '') {
    return 'Field "orderId" is required and must be a non-empty string';
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return 'Field "items" is required and must be a non-empty array';
  }
  if (typeof payload.amount !== 'number') {
    return 'Field "amount" is required and must be numeric';
  }
  if (typeof payload.recipient !== 'string' || payload.recipient.trim() === '') {
    return 'Field "recipient" is required and must be a non-empty string';
  }
  return null;
}

function bootstrapStores() {
  ensureJsonFile(IDEMPOTENCY_STORE_PATH, { records: {} });
  ensureJsonFile(SAGA_STORE_PATH, { sagas: {} });
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/debug/trace/:orderId', (req, res) => {
  const sagaStore = readJsonFile(SAGA_STORE_PATH);
  const saga = sagaStore?.sagas?.[req.params.orderId];
  if (!saga) {
    res.status(404).json({ code: 'not_found', message: 'No saga found for this orderId' });
    return;
  }
  res.status(200).json(saga);
});


async function callService(step, url, payload, trace) {

  // Record the start time for duration calculation
  const started = Date.now();

  // Record the ISO timestamp required by the trace schema
  const startedAt = nowIso();

  try {

    // Make HTTP request to downstream service
    // Example services:
    // payment -> authorize
    // inventory -> reserve
    // shipping -> create
    // notification -> send
    const res = await axios.post(url, payload, {
      timeout: config.requestTimeoutMs
    });

    // Record when the request finished
    const finishedAt = nowIso();

    // Add successful execution record to the trace
    trace.push({
      step: step,
      status: 'success',
      startedAt: startedAt,
      finishedAt: finishedAt,
      durationMs: Date.now() - started
    });

    // Return the response data from the downstream service
    return res.data;

  } catch (err) {

    // If the request fails or times out we still record the trace
    const finishedAt = nowIso();

    // Default failure status
    let status = 'failed';

    // Axios timeout error detection
    // This satisfies the assignment requirement for timeout handling
    if (err.code === 'ECONNABORTED') {
      status = 'timeout';
    }

    // Record failed step in trace
    trace.push({
      step: step,
      status: status,
      startedAt: startedAt,
      finishedAt: finishedAt,
      durationMs: Date.now() - started
    });

    // Re-throw the error so the orchestrator can decide
    // whether to trigger compensation
    throw err;
  }
}

app.post('/checkout', async (req, res) => {
  const idempotencyKey = req.header('Idempotency-Key');
  if (!idempotencyKey) {
    res.status(400).json({
      code: 'validation_error',
      message: 'Idempotency-Key header is required'
    });
    return;
  }

  const validationError = validateCheckoutPayload(req.body);
  if (validationError) {
    res.status(400).json({
      code: 'validation_error',
      message: validationError
    });
    return;
  }

  const requestHash = payloadHash(req.body);
  const idempotencyStore = readJsonFile(IDEMPOTENCY_STORE_PATH);
  if (!idempotencyStore.records) {
    idempotencyStore.records = {};
  }

  const existing = idempotencyStore.records[idempotencyKey];
  if (existing) {
    if (existing.requestHash !== requestHash) {
      console.log(existing.requestHash);
      console.log(requestHash);
      res.status(409).json({
        code: 'idempotency_payload_mismatch',
        message: 'This Idempotency-Key is already used for a different payload'
      });
      return;
    } else if (existing.state == 'completed') {
      res.status(200).json(existing.response);
      return;
    } else if (existing.state == 'in_progress') {
      res.status(409).json({
        code: 'idempotency_conflict',
        message: 'Order is already being processed'
      });
      return;
    }


  }

  const orderId = req.body.orderId;
  idempotencyStore.records[idempotencyKey] = {
    requestHash,
    state: 'in_progress',
    httpStatus: 202,
    response: {
      orderId,
      status: 'in_progress'
    },
    updatedAt: nowIso()
  };
  writeJsonFile(IDEMPOTENCY_STORE_PATH, idempotencyStore);

  // --------------------------------------------------------------------------
  // TODO (student): Implement full orchestration flow:
  //   1) payment authorize
  //   2) inventory reserve
  //   3) shipping create
  //   4) notification send
  // with strict sequencing, trace recording, timeout handling, compensation,
  // idempotent replay policy, and restart-safe persistence updates.
  // --------------------------------------------------------------------------

  let trace = [];

  let paymentDone = false;
  let inventoryDone = false;
  let shippingDone = false;
  try {
    // STEP 1: Payment
    console.log(`[${nowIso()}] STEP 1/4: Calling Payment Service...`);
    console.log(`${config.paymentUrl}/authorize`);
    await callService('payment', `${config.paymentUrl}/payment/authorize`, req.body, trace);
    paymentDone = true;

    // STEP 2: Inventory
    console.log(`[${nowIso()}] STEP 2/4: Calling Inventory Service...`);
    await callService('inventory', `${config.inventoryUrl}/inventory/reserve`, req.body, trace);
    inventoryDone = true;

    // STEP 3: Shipping
    console.log(`[${nowIso()}] STEP 3/4: Calling Shipping Service...`);
    await callService('shipping', `${config.shippingUrl}/shipping/create`, req.body, trace);
    shippingDone = true;

    // STEP 4: Notification
    console.log(`[${nowIso()}] STEP 4/4: Calling Notification Service...`);
    await callService('notification', `${config.notificationUrl}/notification/send`, req.body, trace);

    // SUCCESS
    const response = {
      orderId,
      status: 'completed',
      trace
    };

    // Update idempotency store
    idempotencyStore.records[idempotencyKey] = {
      requestHash,
      state: 'completed',
      httpStatus: 200,
      response,
      updatedAt: nowIso()
    };
    writeJsonFile(IDEMPOTENCY_STORE_PATH, idempotencyStore);

    // Update saga store
    const sagaStore = readJsonFile(SAGA_STORE_PATH);
    if (!sagaStore.sagas) sagaStore.sagas = {};
    sagaStore.sagas[orderId] = {
      idempotencyKey,
      state: 'completed',
      steps: trace,
      updatedAt: nowIso()
    };
    writeJsonFile(SAGA_STORE_PATH, sagaStore);

    return res.status(200).json(response);

  } catch (err) {
    console.log('ERROR HAPPENED:', err.message);

    let httpStatus = 422;
    let code = 'business_failure';
    let compensated = false;

    if (err.code === 'ECONNABORTED' || err.message.includes('timeout')) {
      httpStatus = 504;
      code = 'timeout';
    }

    // COMPENSATION LOGIC
    try {
      if (paymentDone && !inventoryDone) {
        // Payment succeeded but inventory failed - just refund payment
        console.log('Inventory failed - refunding payment');
        await callService('refund_payment', `${config.paymentUrl}/payment/refund`, req.body, trace);
        compensated = true;
      }
      else if (paymentDone && inventoryDone && !shippingDone) {
        // Payment and inventory succeeded but shipping failed
        // Need to release inventory AND refund payment
        console.log('Shipping failed - releasing inventory and refunding payment');
        await callService('release_inventory', `${config.inventoryUrl}/inventory/release`, req.body, trace);
        await callService('refund_payment', `${config.paymentUrl}/payment/refund`, req.body, trace);
        compensated = true;
      }
      else if (paymentDone && inventoryDone && shippingDone) {
        // Payment, inventory, and shipping succeeded but notification failed
        // Need to release inventory AND refund payment
        console.log('Notification failed - releasing inventory and refunding payment');
        await callService('release_inventory', `${config.inventoryUrl}/inventory/release`, req.body, trace);
        await callService('refund_payment', `${config.paymentUrl}/payment/refund`, req.body, trace);
        compensated = true;
      }

    } catch (compErr) {
      console.log('Compensation failed:', compErr.message);
      httpStatus = 422;
      code = 'compensation_failed';
    }

    const response = {
      orderId,
      status: 'failed',
      code: code,
      trace
    };

    // Update idempotency store
    idempotencyStore.records[idempotencyKey] = {
      requestHash,
      state: 'failed',
      httpStatus,
      response,
      updatedAt: nowIso()
    };
    writeJsonFile(IDEMPOTENCY_STORE_PATH, idempotencyStore);

    // Update saga store
    const sagaStore = readJsonFile(SAGA_STORE_PATH);
    if (!sagaStore.sagas) sagaStore.sagas = {};
    sagaStore.sagas[orderId] = {
      idempotencyKey,
      state: compensated ? 'compensated' : 'failed',
      steps: trace,
      updatedAt: nowIso()
    };
    writeJsonFile(SAGA_STORE_PATH, sagaStore);

    return res.status(httpStatus).json(response);
  }
});

bootstrapStores();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[orchestrator] listening on port ${config.port}`);
  console.log('[orchestrator] downstream targets loaded from env', {
    paymentUrl: config.paymentUrl,
    inventoryUrl: config.inventoryUrl,
    shippingUrl: config.shippingUrl,
    notificationUrl: config.notificationUrl,
    requestTimeoutMs: config.requestTimeoutMs
  });
});

