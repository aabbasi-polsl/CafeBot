const path = require('path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const crypto = require('node:crypto');
const express = require('express');
const dotenv = require('dotenv');
const OpenAI = require('openai');

const backendEnvPath = path.resolve(__dirname, 'env/.env');
const projectEnvPath = path.resolve(__dirname, '../env/.env');
dotenv.config({ path: fs.existsSync(backendEnvPath) ? backendEnvPath : projectEnvPath });

const app = express();
const projectRoot = path.resolve(__dirname, '..');
const frontendPath = path.join(projectRoot, 'frontend');
const menuPath = path.join(projectRoot, 'data', 'menu.json');
const ordersPath = path.resolve(projectRoot, 'data', 'orders.json');
const timingPath = path.join(projectRoot, 'data', 'timing.json');
const timingsPath = fs.existsSync(timingPath) ? timingPath : path.join(projectRoot, 'data', 'timings.json');
const systemPromptPath = path.join(projectRoot, 'prompts', 'system-prompt.md');
const port = Number(process.env.PORT) || 3000;
const orderSessions = new Map();
let orderWriteQueue = Promise.resolve();
const sessionCookieName = 'cafebot_session';
const sessionTtlMs = 2 * 60 * 60 * 1000;

const responseFormat = {
  type: 'json_schema',
  name: 'cafebot_chat_turn',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reply: { type: 'string' },
      showOrderSummary: { type: 'boolean' },
      orderDetailsUpdate: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderType: { anyOf: [{ type: 'string', enum: ['pickup', 'dine_in', 'delivery'] }, { type: 'null' }] },
          customerName: { anyOf: [{ type: 'string', maxLength: 80 }, { type: 'null' }] },
          phone: { anyOf: [{ type: 'string', maxLength: 40 }, { type: 'null' }] },
          pickupTime: { anyOf: [{ type: 'string', maxLength: 50 }, { type: 'null' }] },
          streetAddress: { anyOf: [{ type: 'string', maxLength: 160 }, { type: 'null' }] },
          unit: { anyOf: [{ type: 'string', maxLength: 80 }, { type: 'null' }] },
          city: { anyOf: [{ type: 'string', maxLength: 100 }, { type: 'null' }] },
          postalCode: { anyOf: [{ type: 'string', maxLength: 30 }, { type: 'null' }] },
          deliveryInstructions: { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] },
        },
        required: ['orderType', 'customerName', 'phone', 'pickupTime', 'streetAddress', 'unit', 'city', 'postalCode', 'deliveryInstructions'],
      },
      addItems: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            menuItemId: { type: 'string' },
            quantity: { type: 'integer', minimum: 1, maximum: 99 },
            size: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            options: { type: 'array', items: { type: 'string' } },
          },
          required: ['menuItemId', 'quantity', 'size', 'options'],
        },
      },
      modifyItems: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lineId: { type: 'string' },
            requestedFields: {
              type: 'array',
              items: { type: 'string', enum: ['quantity', 'size', 'options'] },
          },
            quantity: { anyOf: [{ type: 'integer', minimum: 1, maximum: 99 }, { type: 'null' }] },
            size: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            options: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
          },
          required: ['lineId', 'requestedFields', 'quantity', 'size', 'options'],
        },
      },
      removeItems: {
        type: 'array',
        maxItems: 20,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            lineId: { type: 'string' },
            action: { type: 'string', enum: ['remove', 'set_quantity'] },
            quantity: { anyOf: [{ type: 'integer', minimum: 1, maximum: 99 }, { type: 'null' }] },
          },
          required: ['lineId', 'action', 'quantity'],
        },
      },
    },
    required: ['reply', 'showOrderSummary', 'orderDetailsUpdate', 'addItems', 'modifyItems', 'removeItems'],
  },
};

function createEmptyOrderState() {
  return {
    items: [],
    pendingItems: [],
    pendingChanges: [],
    pendingRemovals: [],
    orderType: null,
    customerDetails: { name: null, phone: null },
    deliveryAddress: { streetAddress: null, unit: null, city: null, postalCode: null, instructions: null, confirmation: 'not_requested' },
    pickupTime: null,
    promotion: { code: null, status: 'not_provided' },
    itemSubtotalPln: 0,
    taxPln: null,
    deliveryFeePln: null,
    totalPln: null,
    confirmation: 'not_requested',
    status: 'empty',
  };
}

function priceToGrosz(price) {
  if (!Number.isFinite(price) || price < 0) throw new Error('Menu price data is invalid.');
  return Math.round(price * 100);
}

function getUnitPriceGrosz(menuItem, sizeName, options) {
  const size = (menuItem.sizes || []).find(option => option.name === sizeName);
  if (sizeName && !size) throw new Error(`Choose a size listed for ${menuItem.name}.`);
  const optionPrices = options.map(name => (menuItem.options || []).find(option => option.name === name)?.additional_price_pln);
  if (optionPrices.some(price => price === undefined)) throw new Error(`Choose only options listed for ${menuItem.name}.`);
  return priceToGrosz(menuItem.price_pln) +
    (size ? priceToGrosz(size.price_adjustment_pln) : 0) +
    optionPrices.reduce((sum, price) => sum + priceToGrosz(price), 0);
}

function refreshOrderPricing(state, menu) {
  let subtotalGrosz = 0;
  for (const item of state.items) {
    const menuItem = menu.items.find(entry => entry.id === item.menuItemId);
    if (!menuItem || !Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new Error('The current order contains an invalid menu item or quantity.');
    }
    const unitPriceGrosz = getUnitPriceGrosz(menuItem, item.size, item.options);
    item.name = menuItem.name;
    item.unitPricePln = unitPriceGrosz / 100;
    subtotalGrosz += unitPriceGrosz * item.quantity;
  }
  state.itemSubtotalPln = subtotalGrosz / 100;
  state.taxPln = null;
  state.deliveryFeePln = state.orderType === 'delivery' ? null : 0;
  state.totalPln = state.taxPln === null || state.deliveryFeePln === null
    ? null
    : state.itemSubtotalPln + state.taxPln + state.deliveryFeePln;
}

function getPricingNote(state, currency) {
  const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);
  const subtotal = `Items subtotal: ${money(state.itemSubtotalPln)}.`;
  const deliveryFee = state.orderType === 'delivery'
    ? 'Delivery fee: not confirmed.'
    : state.orderType
      ? 'Delivery fee: not applicable.'
      : 'Delivery fee: not confirmed until order type is known.';
  return `${subtotal} Tax: not confirmed. ${deliveryFee} Final total is not confirmed.`;
}

function getOrderSession(req, res) {
  const cookies = (req.headers.cookie || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${sessionCookieName}=`));
  let id = cookie?.slice(sessionCookieName.length + 1);
  const validId = /^[0-9a-f-]{36}$/i.test(id || '');

  for (const [sessionId, session] of orderSessions) {
    if (Date.now() - session.lastUsed > sessionTtlMs) orderSessions.delete(sessionId);
  }

  if (!validId || !orderSessions.has(id)) {
    id = crypto.randomUUID();
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${sessionCookieName}=${id}; HttpOnly; SameSite=Lax; Path=/${secure}`);
  }

  let session = orderSessions.get(id);
  if (!session) {
    session = { orderState: createEmptyOrderState(), pendingOrderConfirmation: null, awaitingAnotherItem: false, lastUsed: Date.now() };
    orderSessions.set(id, session);
  }
  session.lastUsed = Date.now();
  return session;
}

function createConfirmedOrderRecord(snapshot) {
  const validOrderTypes = ['pickup', 'dine_in', 'delivery'];
  if (!snapshot || !validOrderTypes.includes(snapshot.orderType) || !Array.isArray(snapshot.items) || !snapshot.items.length || !snapshot.customerDetails?.name) {
    throw new Error('The order is missing required confirmation details.');
  }
  if (snapshot.orderType === 'delivery') {
    const phoneDigits = String(snapshot.customerDetails.phone || '').replace(/\D/g, '');
    const address = snapshot.deliveryAddress;
    if (
      phoneDigits.length < 7 || phoneDigits.length > 15 ||
      !address?.streetAddress || !/\d/.test(address.streetAddress) ||
      !address.city || !address.postalCode || !address.instructions ||
      address.confirmation !== 'confirmed'
    ) {
      throw new Error('Delivery details must be complete and address-confirmed before saving.');
    }
  }
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    status: 'confirmed',
    customer: {
      name: snapshot.customerDetails.name,
      phone: snapshot.customerDetails.phone || null,
    },
    fulfillment: {
      type: snapshot.orderType,
      pickupTime: snapshot.orderType === 'pickup' ? snapshot.pickupTime : null,
      deliveryAddress: {
        streetAddress: snapshot.deliveryAddress?.streetAddress || null,
        unit: snapshot.deliveryAddress?.unit || null,
        city: snapshot.deliveryAddress?.city || null,
        postalCode: snapshot.deliveryAddress?.postalCode || null,
        instructions: snapshot.deliveryAddress?.instructions || null,
        addressConfirmed: snapshot.orderType === 'delivery' ? true : null,
      },
    },
    items: snapshot.items.map(item => ({
      menuItemId: item.menuItemId,
      name: item.name,
      quantity: item.quantity,
      size: item.size,
      customizations: [...item.options],
      unitPricePln: item.unitPricePln,
      lineTotalPln: item.lineTotalPln,
    })),
    pricing: {
      currency: snapshot.pricing.currency,
      subtotalPln: snapshot.pricing.itemSubtotalPln,
      taxPln: snapshot.pricing.taxPln,
      taxStatus: snapshot.pricing.taxStatus,
      deliveryFeePln: snapshot.pricing.deliveryFeePln,
      deliveryFeeStatus: snapshot.pricing.deliveryFeeStatus,
      totalPln: snapshot.pricing.totalPln,
      totalStatus: snapshot.pricing.totalStatus,
    },
    customerConfirmed: true,
  };
}

function appendConfirmedOrder(order) {
  const write = orderWriteQueue.then(async () => {
    const currentOrders = JSON.parse(await fsPromises.readFile(ordersPath, 'utf8'));
    if (!Array.isArray(currentOrders)) throw new Error('Order storage must contain a JSON array.');
    let orderToSave = order;
    while (currentOrders.some(existing => existing.id === orderToSave.id)) {
      orderToSave = { ...orderToSave, id: crypto.randomUUID() };
    }
    await fsPromises.writeFile(ordersPath, `${JSON.stringify([...currentOrders, orderToSave], null, 2)}\n`, 'utf8');
    const savedOrders = JSON.parse(await fsPromises.readFile(ordersPath, 'utf8'));
    if (!Array.isArray(savedOrders) || !savedOrders.some(saved =>
      saved.id === orderToSave.id && JSON.stringify(saved) === JSON.stringify(orderToSave)
    )) {
      throw new Error('Confirmed order write could not be verified from order storage.');
    }
    return orderToSave;
  });
  orderWriteQueue = write.catch(() => {});
  return write;
}

function messageConfirmsQuantity(message, menuItem, quantity) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const quantityTerms = quantity === 1 ? ['1', 'one', 'a', 'an'] : [String(quantity), words[quantity]].filter(Boolean);
  const itemName = `${menuItem.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}s?`;
  return quantityTerms.some(term => {
    const count = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:\\b${count}\\b\\s+(?:\\w+\\s+){0,3}${itemName}\\b|\\b${itemName}\\b(?:\\s+\\w+){0,3}\\s+\\b${count}\\b)`, 'i').test(message);
  });
}

function prepareAddItems(entries, menu, message) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 20) {
    throw new Error('No valid menu items were requested.');
  }

  return entries.map(entry => {
    const menuItem = menu.items.find(item => item.id === entry.menuItemId);
    if (!menuItem || !menuItem.available) throw new Error('Order item is not available or valid.');
    if (!Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 99) throw new Error('Quantity must be from 1 to 99.');
    if (!messageConfirmsQuantity(message, menuItem, entry.quantity)) {
      throw new Error(`Please tell me how many ${menuItem.name} you would like—for example, “2 ${menuItem.name}s”.`);
    }

    const sizes = Array.isArray(menuItem.sizes) ? menuItem.sizes : [];
    const selectedSizeName = entry.size || null;
    const size = selectedSizeName === null ? null : sizes.find(option => option.name === selectedSizeName);
    if (selectedSizeName !== null && !size) throw new Error(`Available sizes for ${menuItem.name}: ${sizes.map(option => option.name).join(', ') || 'none'}.`);
    if (
      !Array.isArray(entry.options) ||
      new Set(entry.options).size !== entry.options.length ||
      entry.options.some(option => !(menuItem.options || []).some(allowed => allowed.name === option))
    ) {
      throw new Error(`Available customizations for ${menuItem.name}: ${(menuItem.options || []).map(option => option.name).join(', ') || 'none'}.`);
    }

    const requiredOptions = (menuItem.options || []).filter(option => option.required === true);
    const missingOptions = requiredOptions.filter(option => !entry.options.includes(option.name));
    const unitPriceGrosz = getUnitPriceGrosz(menuItem, size?.name || null, entry.options);
    return {
      menuItemId: menuItem.id,
      name: menuItem.name,
      quantity: entry.quantity,
      size: size?.name || null,
      options: [...new Set(entry.options)],
      unitPricePln: unitPriceGrosz / 100,
      missingSize: sizes.length > 0 && !size,
      missingOptions: missingOptions.map(option => option.name),
      availableSizes: sizes.map(option => option.name),
    };
  });
}

function formatOrderItems(items, currency) {
  return items.map(item => {
    const details = [item.size, ...item.options].filter(Boolean).join(', ');
    return `${item.quantity} × ${item.name}${details ? ` (${details})` : ''}`;
  }).join('; ');
}

function getCurrentOrderSummary(state, currency) {
  const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);
  const summary = state.items.length
    ? `Your current order: ${state.items.map(item => `${item.quantity} × ${item.name}${[item.size, ...item.options].filter(Boolean).length ? ` (${[item.size, ...item.options].filter(Boolean).join(', ')})` : ''} at ${money(item.unitPricePln)} each`).join('; ')}. ${getPricingNote(state, currency)}`
    : 'Your current order is empty.';
  const details = [
    state.orderType ? `Type: ${state.orderType === 'pickup' ? 'pickup' : state.orderType === 'delivery' ? 'delivery' : 'dine-in'}` : '',
    state.customerDetails.name ? `Name: ${state.customerDetails.name}` : '',
    state.pickupTime ? `Pickup time: ${state.pickupTime}` : '',
  ].filter(Boolean);

  const pending = [
    ...state.pendingItems.map(item => `add ${formatOrderItems([item], currency)}`),
    ...state.pendingChanges.map(item => `update ${formatOrderItems([item], currency)}`),
    ...state.pendingRemovals.map(item => item.action === 'remove' ? `remove ${item.currentQuantity} × ${item.name}` : `reduce ${item.name} from ${item.currentQuantity} to ${item.quantity}`),
  ];
  const detailSummary = details.length ? ` ${details.join('. ')}.` : '';
  return `${summary}${detailSummary}${pending.length ? ` Pending confirmation: ${pending.join('; ')}.` : ''}`;
}

function getCheckoutOrderSummary(state, currency, askToAddAnother = false) {
  if (!state.items.length) return 'Your order draft is empty. Add an item before checkout. Checkout is not available in this chat yet.';
  const money = value => new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(value);
  const items = state.items.map(item => {
    const unitPriceGrosz = priceToGrosz(item.unitPricePln);
    const lineTotal = money((unitPriceGrosz * item.quantity) / 100);
    const customizations = [item.size, ...item.options].filter(Boolean).join(', ');
    return `- ${item.quantity} × ${item.name}${customizations ? ` (${customizations})` : ''} — ${money(item.unitPricePln)} each; ${lineTotal} line total`;
  }).join('\n');
  const fulfillment = state.orderType === 'delivery'
    ? [
        'Delivery',
        `Name: ${state.customerDetails.name}`,
        `Phone: ${state.customerDetails.phone || 'Not provided'}`,
        `Address: ${state.deliveryAddress.streetAddress}${state.deliveryAddress.unit !== 'None' ? `, ${state.deliveryAddress.unit}` : ''}, ${state.deliveryAddress.city}, ${state.deliveryAddress.postalCode}`,
        `Delivery instructions: ${state.deliveryAddress.instructions}`,
      ].join('\n')
    : [
        state.orderType === 'pickup' ? 'Pickup' : 'Dine-in',
        `Name: ${state.customerDetails.name}`,
        `Phone: ${state.customerDetails.phone || 'Not provided'}`,
        ...(state.orderType === 'pickup' ? [`Pickup time: ${state.pickupTime || 'Not provided'}`] : []),
      ].join('\n');
  const deliveryFee = state.orderType === 'delivery' ? 'Not confirmed' : 'Not applicable';
  return [
    askToAddAnother ? 'Current order summary' : 'Order summary (awaiting your confirmation)',
    'Items:',
    items,
    `Fulfilment:\n${fulfillment}`,
    `Items subtotal: ${money(state.itemSubtotalPln)}`,
    'Tax: Not confirmed',
    `Delivery fee: ${deliveryFee}`,
    'Final total: Not confirmed (tax and any delivery fee are not configured).',
    askToAddAnother
      ? 'Would you like to add another item? Reply “yes” and tell me what you would like, or “no” to continue to final order confirmation.'
      : 'Reply “confirm order” to save this order as confirmed, or tell me what to change. This saves a local development record; it does not process payment or send the order to the cafe.',
  ].join('\n\n');
}

function createPendingOrderSnapshot(state, currency) {
  return {
    items: state.items.map(item => {
      const unitPriceGrosz = priceToGrosz(item.unitPricePln);
      return {
        menuItemId: item.menuItemId,
        name: item.name,
        quantity: item.quantity,
        size: item.size,
        options: [...item.options],
        unitPricePln: unitPriceGrosz / 100,
        lineTotalPln: unitPriceGrosz * item.quantity / 100,
      };
    }),
    orderType: state.orderType,
    customerDetails: { ...state.customerDetails },
    pickupTime: state.pickupTime,
    deliveryAddress: state.orderType === 'delivery'
      ? {
          streetAddress: state.deliveryAddress.streetAddress,
          unit: state.deliveryAddress.unit === 'None' ? null : state.deliveryAddress.unit,
          city: state.deliveryAddress.city,
          postalCode: state.deliveryAddress.postalCode,
          instructions: state.deliveryAddress.instructions,
          confirmation: state.deliveryAddress.confirmation,
        }
      : null,
    promotion: { ...state.promotion },
    pricing: {
      currency,
      itemSubtotalPln: state.itemSubtotalPln,
      taxPln: state.taxPln,
      taxStatus: 'not_configured',
      deliveryFeePln: state.deliveryFeePln,
      deliveryFeeStatus: state.orderType === 'delivery' ? 'not_configured' : 'not_applicable',
      totalPln: state.totalPln,
      totalStatus: 'unconfirmed',
    },
  };
}

function detectOrderTypeIntent(message) {
  const text = message.normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();
  const tentativeChoice = /\b(?:maybe|perhaps|possibly|i think|i guess|not sure|might be|could be)\b/.test(text);
  const switchTarget = text.match(/\b(?:switch|change|make|set)\b.*\b(?:to|as)\s+(?:a\s+)?(pickup|pick[\s-]?up|dine[\s-]?in|delivery)\b/);
  const normalize = value => value.startsWith('pick') ? 'pickup' : value.startsWith('dine') ? 'dine_in' : value === 'delivery' ? 'delivery' : null;
  if (switchTarget && !tentativeChoice) return { orderType: normalize(switchTarget[1]), ambiguous: false };

  const patterns = {
    pickup: /^(?:please\s+)?(?:pickup|pick[\s-]?up|takeaway|take[\s-]?out)[.!?]*$|\b(?:for|as|prefer|choose|select|switch to|change to|go with|do|let's do|i want|i'd like|i would like)\s+(?:a\s+)?(?:pickup|pick[\s-]?up|takeaway|take[\s-]?out)\b|\b(?:pickup|pick[\s-]?up) order\b|\bcollect (?:my|the) order\b|\b(?:i'll|i will) pick (?:it|this|my order) up\b/,
    dine_in: /^(?:please\s+)?(?:dine[\s-]?in|eat here|eat in)[.!?]*$|\b(?:for|as|prefer|choose|select|switch to|change to|go with|do|let's do|i want|i'd like|i would like)\s+(?:a\s+)?dine[\s-]?in\b|\beat (?:here|in)\b/,
    delivery: /^(?:please\s+)?delivery[.!?]*$|\b(?:for|as|prefer|choose|select|switch to|change to|go with|do|let's do|i want|i'd like|i would like)\s+(?:a\s+)?delivery\b|\bdelivery order\b|\bdeliver (?:it|this|my order)\b|\bhave (?:it|this|my order) delivered\b|\bto be delivered\b/,
  };
  const matches = Object.entries(patterns).filter(([, pattern]) => pattern.test(text)).map(([type]) => type);
  const mentionedTypes = [
    /\b(?:pickup|pick[\s-]?up|takeaway|take[\s-]?out)\b/.test(text) ? 'pickup' : null,
    /\b(?:dine[\s-]?in|eat here|eat in)\b/.test(text) ? 'dine_in' : null,
    /\b(?:delivery|deliver(?:ed)?)\b/.test(text) ? 'delivery' : null,
  ].filter(Boolean);
  const joinedAlternatives = mentionedTypes.length > 1 && /\b(?:or|either)\b/.test(text);
  return {
    orderType: matches.length === 1 && !joinedAlternatives && !tentativeChoice ? matches[0] : null,
    ambiguous: matches.length > 1 || joinedAlternatives || (tentativeChoice && mentionedTypes.length > 0),
  };
}

function getLastAssistantMessage(conversationHistory) {
  return Array.isArray(conversationHistory)
    ? [...conversationHistory].reverse().find(item => item?.role === 'assistant' && typeof item.content === 'string')?.content || ''
    : '';
}

function applyOrderDetailsUpdate(state, update, message, conversationHistory) {
  let changed = false;
  const issues = [];
  let addressChanged = false;
  const normalizedMessage = message.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const lastAssistantMessage = getLastAssistantMessage(conversationHistory);
  const provided = value => typeof value === 'string' && value.trim() && normalizedMessage.includes(value.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' '));
  const providedPhone = value => {
    if (typeof value !== 'string') return false;
    const digits = value.replace(/\D/g, '');
    const messageDigits = message.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 && messageDigits.includes(digits);
  };
  const genericNoneReply = /^(none|no|n\/a|not applicable)[.!\s]*$/i.test(message.trim());
  const unitIsNone = /\b(no unit|no apartment|no apartment number|no house number|not applicable)\b/i.test(message) ||
    (genericNoneReply && /apartment|house|unit number/i.test(lastAssistantMessage));
  const instructionsAreNone = /\b(no special instructions|no delivery instructions|no instructions)\b/i.test(message) ||
    (genericNoneReply && /delivery instructions/i.test(lastAssistantMessage));
  const orderTypeIntent = detectOrderTypeIntent(message);
  if (orderTypeIntent.orderType && orderTypeIntent.orderType !== state.orderType) {
    state.orderType = orderTypeIntent.orderType;
    changed = true;
  }

  const name = typeof update?.customerName === 'string' ? update.customerName.trim().slice(0, 80) : '';
  if (name && provided(name) && name !== state.customerDetails.name) {
    state.customerDetails.name = name;
    changed = true;
  }

  const pickupTime = typeof update?.pickupTime === 'string' ? update.pickupTime.trim().slice(0, 50) : '';
  if (pickupTime && provided(pickupTime) && pickupTime !== state.pickupTime) {
    state.pickupTime = pickupTime;
    changed = true;
  }

  const phone = typeof update?.phone === 'string' ? update.phone.trim().slice(0, 40) : '';
  if (phone && provided(phone) && !providedPhone(phone)) {
    issues.push('That phone number is invalid. Please provide a number with 7 to 15 digits.');
  } else if (phone && providedPhone(phone) && phone !== state.customerDetails.phone) {
    state.customerDetails.phone = phone;
    changed = true;
  }
  if (!state.customerDetails.phone && /phone number/i.test(lastAssistantMessage) && !phone) {
    issues.push('I did not catch a phone number. Please provide one with 7 to 15 digits.');
  }

  for (const [key, value] of Object.entries({
      streetAddress: update?.streetAddress,
      city: update?.city,
      postalCode: update?.postalCode,
      instructions: update?.deliveryInstructions,
  })) {
    const field = typeof value === 'string' ? value.trim() : '';
    if (key === 'streetAddress' && field && provided(field) && !/\d/.test(field)) {
      issues.push('Please include the house or building number in the street address.');
      if (state.orderType === 'delivery') {
        state.deliveryAddress.confirmation = 'needs_correction';
        changed = true;
      }
      continue;
    }
    if (key === 'city' && field && provided(field) && !/\p{L}{2}/u.test(field)) {
      issues.push('Please provide the city name so I can complete the delivery address.');
      continue;
    }
    if (key === 'postalCode' && field && provided(field) && !/^[\p{L}\p{N}][\p{L}\p{N} -]{1,17}$/u.test(field)) {
      issues.push('That postal code looks incomplete. Please provide the full postal code.');
      continue;
    }
    if (field && (provided(field) && !(key === 'instructions' && /^none$/i.test(field)) || key === 'instructions' && instructionsAreNone) && field !== state.deliveryAddress[key]) {
      state.deliveryAddress[key] = field;
      changed = true;
      if (key !== 'instructions') addressChanged = true;
    } else if (key === 'instructions' && instructionsAreNone && !state.deliveryAddress.instructions) {
      state.deliveryAddress.instructions = 'None';
      changed = true;
    }
  }

  const unit = typeof update?.unit === 'string' ? update.unit.trim() : '';
  if (unit && ((provided(unit) && !/^none$/i.test(unit)) || (unitIsNone && /^none$/i.test(unit))) && unit !== state.deliveryAddress.unit) {
    state.deliveryAddress.unit = unit;
    changed = true;
    addressChanged = true;
  } else if (!unit && unitIsNone && !state.deliveryAddress.unit) {
    state.deliveryAddress.unit = 'None';
    changed = true;
    addressChanged = true;
  }
  if (state.orderType === 'delivery' && state.deliveryAddress.unit === null && /apartment, house, or unit/i.test(lastAssistantMessage) && !unit && !unitIsNone) {
    issues.push('Please provide the apartment, house, or unit number, or say “none” if there is no unit.');
  }

  if (addressChanged) state.deliveryAddress.confirmation = 'not_requested';
  if (state.orderType === 'delivery') {
    const explicitConfirmation = /^(yes(?:,? (?:it is|the address is (?:correct|right)))?|correct|that's correct|that is correct|confirmed|confirm|looks correct|that's right|that is right)\s*[.!]?$/i.test(message.trim());
    const explicitCorrection = /^(no|no,|incorrect|that's wrong|that is wrong|not correct)\b/i.test(message.trim());
    if (state.deliveryAddress.confirmation === 'awaiting_confirmation' && explicitConfirmation && !addressChanged) {
      state.deliveryAddress.confirmation = 'confirmed';
      changed = true;
    } else if (state.deliveryAddress.confirmation === 'awaiting_confirmation' && explicitCorrection && !addressChanged) {
      state.deliveryAddress.confirmation = 'needs_correction';
      changed = true;
    }
  }
  return { changed, issue: issues.join(' ') };
}

function nextMissingOrderDetailQuestion(state) {
  const pendingItem = state.pendingItems.find(item => item.missingSize || item.missingOptions?.length);
  if (pendingItem?.missingSize) return `What size would you like for ${pendingItem.name}? Choose from ${pendingItem.availableSizes.join(', ')}. For example, “${pendingItem.availableSizes[0]}”.`;
  if (pendingItem?.missingOptions?.length) return `Which required option would you like for ${pendingItem.name}? Choose from ${pendingItem.missingOptions.join(', ')}. For example, “${pendingItem.missingOptions[0]}”.`;
  const pendingChange = state.pendingChanges.find(item => item.missingQuantity || item.missingSize || item.needsOptions || item.missingOptions?.length);
  if (pendingChange?.missingQuantity) return `What quantity would you like for ${pendingChange.name}? Enter a number from 1 to 99, for example, “2”.`;
  if (pendingChange?.missingSize) return `What size would you like for ${pendingChange.name}? Choose from ${pendingChange.availableSizes.join(', ')}. For example, “${pendingChange.availableSizes[0]}”.`;
  if (pendingChange?.needsOptions) return `Which available customizations would you like for ${pendingChange.name}? Choose from ${pendingChange.availableOptions.join(', ') || 'none'}. For example, “${pendingChange.availableOptions[0] || 'none'}”.`;
  if (pendingChange?.missingOptions?.length) return `Which required option would you like for ${pendingChange.name}? Choose from ${pendingChange.missingOptions.join(', ')}. For example, “${pendingChange.missingOptions[0]}”.`;
  if (!state.items.length) return null;
  if (!state.orderType) return 'Would you like pickup, dine-in, or delivery? For example, “pickup”.';
  if (!state.customerDetails.name) return 'What name should I put on the order? For example, “Alex”.';
  if (state.orderType === 'delivery') {
    if (!state.customerDetails.phone) return 'What phone number should the courier use? Enter 7 to 15 digits, for example, “5551234567”.';
    if (!state.deliveryAddress.streetAddress) return 'What street address should the delivery go to? Include the building number, for example, “123 Main Street”.';
    if (!state.deliveryAddress.city) return 'What city is that delivery address in? For example, “Warsaw”.';
    if (!state.deliveryAddress.postalCode) return 'What is the postal code? For example, “00-001”.';
    if (state.deliveryAddress.unit === null) return 'Is there an apartment, house, or unit number? For example, “Apt 2”, or say “none”.';
    if (!state.deliveryAddress.instructions) return 'What delivery instructions should I include? For example, “Side entrance”, or say “none”.';
    if (state.deliveryAddress.confirmation === 'needs_correction') return 'What part of the delivery address should I correct?';
    if (state.deliveryAddress.confirmation !== 'confirmed') {
      state.deliveryAddress.confirmation = 'awaiting_confirmation';
      const unit = state.deliveryAddress.unit === 'None' ? '' : `, ${state.deliveryAddress.unit}`;
      return `Please confirm this delivery address: ${state.deliveryAddress.streetAddress}${unit}, ${state.deliveryAddress.city}, ${state.deliveryAddress.postalCode}. Is that correct? Reply “yes” or tell me what to correct.`;
    }
  }
  return null;
}

function prepareModifyItems(entries, state, menu) {
  if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid item changes.');
  const seen = new Set();
  return entries.map(entry => {
    if (seen.has(entry.lineId)) throw new Error('An order item was listed more than once.');
    seen.add(entry.lineId);
    const current = state.items.find(item => item.lineId === entry.lineId);
    const menuItem = current && menu.items.find(item => item.id === current.menuItemId);
    if (!current || !menuItem || !menuItem.available) throw new Error('That order item is not available to modify.');

    const fields = new Set(entry.requestedFields);
    const sizes = Array.isArray(menuItem.sizes) ? menuItem.sizes : [];
    const menuOptions = menuItem.options || [];
    const missingQuantity = fields.has('quantity') && entry.quantity === null;
    const missingSize = fields.has('size') && entry.size === null;
    const needsOptions = fields.has('options') && entry.options === null;
    const missingOptions = menuOptions
      .filter(option => option.required === true && !(fields.has('options') && entry.options !== null ? entry.options : current.options).includes(option.name))
      .map(option => option.name);
    const quantity = fields.has('quantity') && entry.quantity !== null ? entry.quantity : current.quantity;
    if (quantity < 1 || quantity > 99) throw new Error('Quantity must be from 1 to 99.');

    const sizeName = fields.has('size') && entry.size !== null ? entry.size : current.size;
    const size = sizes.find(option => option.name === sizeName);
    if (sizeName !== null && !size) {
      throw new Error(`Available sizes for ${menuItem.name}: ${sizes.map(option => option.name).join(', ')}.`);
    }

    const options = fields.has('options') && entry.options !== null ? entry.options : current.options;
    if (
      !Array.isArray(options) ||
      new Set(options).size !== options.length ||
      options.some(option => !menuOptions.some(allowed => allowed.name === option))
    ) {
      throw new Error(`Available customizations for ${menuItem.name}: ${menuOptions.map(option => option.name).join(', ') || 'none'}.`);
    }

    const unitPriceGrosz = getUnitPriceGrosz(menuItem, size?.name || null, options);
    return {
      lineId: current.lineId,
      menuItemId: current.menuItemId,
      name: menuItem.name,
      quantity,
      size: size?.name || null,
      options: [...options],
      unitPricePln: unitPriceGrosz / 100,
      missingQuantity,
      missingSize,
      needsOptions,
      missingOptions,
      availableSizes: sizes.map(option => option.name),
      availableOptions: menuOptions.map(option => option.name),
    };
  });
}

function prepareRemoveItems(entries, state, menu) {
  if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid order removals.');
  const seen = new Set();
  return entries.map(entry => {
    if (seen.has(entry.lineId)) throw new Error('An order item was listed more than once.');
    seen.add(entry.lineId);
    const current = state.items.find(item => item.lineId === entry.lineId);
    const menuItem = current && menu.items.find(item => item.id === current.menuItemId);
    if (!current || !menuItem) throw new Error('That order item was not found.');
    if (entry.action === 'remove') {
      return { lineId: current.lineId, name: menuItem.name, action: 'remove', currentQuantity: current.quantity, quantity: null };
    }
    if (entry.action !== 'set_quantity' || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity >= current.quantity) {
      throw new Error(`Choose a lower quantity for ${menuItem.name}, or remove the item.`);
    }
    return {
      lineId: current.lineId,
      name: menuItem.name,
      action: 'set_quantity',
      currentQuantity: current.quantity,
      quantity: entry.quantity,
    };
  });
}

function completePendingAddItems(state, message, menu) {
  if (!state.pendingItems.length) return null;
  const normalizedMessage = message.normalize('NFKC').toLowerCase();
  const completed = [];
  const remaining = [];

  for (const pending of state.pendingItems) {
    const menuItem = menu.items.find(item => item.id === pending.menuItemId);
    if (!menuItem || !menuItem.available) throw new Error('Order item is not available or valid.');
    let size = pending.size;
    if (pending.missingSize) {
      const mentionedSizes = (menuItem.sizes || []).filter(option => {
        const escapedName = option.name.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escapedName}\\b`, 'i').test(message.normalize('NFKC'));
      });
      if (mentionedSizes.length !== 1) {
        return `What size would you like for ${menuItem.name}? Choose from ${(menuItem.sizes || []).map(option => option.name).join(', ')}. For example, “${menuItem.availableSizes[0]}”.`;
      }
      size = mentionedSizes[0].name;
    }

    const options = [...pending.options];
    for (const required of (menuItem.options || []).filter(option => option.required === true)) {
      if (!options.includes(required.name) && normalizedMessage.includes(required.name.normalize('NFKC').toLowerCase())) {
        options.push(required.name);
      }
    }
    const missingOptions = (menuItem.options || []).filter(option => option.required === true && !options.includes(option.name));
    if (missingOptions.length) {
      remaining.push({ ...pending, size, options, missingSize: false, missingOptions: missingOptions.map(option => option.name) });
      continue;
    }

    const unitPriceGrosz = getUnitPriceGrosz(menuItem, size, options);
    const { missingSize, missingOptions: _missingOptions, availableSizes, ...readyItem } = pending;
    completed.push({ ...readyItem, lineId: crypto.randomUUID(), size, options, unitPricePln: unitPriceGrosz / 100 });
  }

  state.pendingItems = remaining;
  if (remaining.length) {
    const pending = remaining[0];
    const question = pending.missingOptions?.length
      ? `Which required option would you like for ${pending.name}? Choose from ${pending.missingOptions.join(', ')}. For example, “${pending.missingOptions[0]}”.`
      : `What size would you like for ${pending.name}? Choose from ${pending.availableSizes.join(', ')}. For example, “${pending.availableSizes[0]}”.`;
    return question;
  }

  const hasSameOptions = (left, right) => left.length === right.length && left.every(option => right.includes(option));
  for (const addedItem of completed) {
    const matchingItem = state.items.find(item => item.menuItemId === addedItem.menuItemId && item.size === addedItem.size && hasSameOptions(item.options, addedItem.options) && item.quantity + addedItem.quantity <= 99);
    if (matchingItem) matchingItem.quantity += addedItem.quantity;
    else state.items.push(addedItem);
  }
  if (completed.length) {
    state.status = 'draft';
    state.confirmation = 'not_requested';
    refreshOrderPricing(state, menu);
    return `Added ${formatOrderItems(completed, menu.currency)}. ${getPricingNote(state, menu.currency)}`;
  }
  return null;
}

function updateDraftAfterRequests(state, addEntries, modifyEntries, removeEntries, menu, message) {
  if (!addEntries.length && !modifyEntries.length && !removeEntries.length) {
    return completePendingAddItems(state, message, menu);
  }

  const requestedAdds = addEntries.length ? prepareAddItems(addEntries, menu, message) : [];
  const replacedIds = new Set(requestedAdds.map(item => item.menuItemId));
  const candidates = [
    ...state.pendingItems.filter(item => !replacedIds.has(item.menuItemId)),
    ...requestedAdds,
  ];
  const changes = modifyEntries.length ? prepareModifyItems(modifyEntries, state, menu) : [];
  const removals = removeEntries.length ? prepareRemoveItems(removeEntries, state, menu) : [];
  if (changes.some(change => removals.some(removal => removal.lineId === change.lineId))) {
    throw new Error('An item cannot be modified and removed in the same request.');
  }

  const incompleteChange = changes.find(change => change.missingQuantity || change.missingSize || change.needsOptions || change.missingOptions.length);
  if (incompleteChange) {
    state.pendingItems = candidates;
    state.pendingChanges = changes;
    state.pendingRemovals = removals;
    state.status = 'awaiting_details';
    state.confirmation = 'not_requested';
    if (incompleteChange.missingQuantity) return `What quantity would you like for ${incompleteChange.name}? Enter a number from 1 to 99, for example, “2”.`;
    if (incompleteChange.missingSize) return `What size would you like for ${incompleteChange.name}? Choose from ${incompleteChange.availableSizes.join(', ')}. For example, “${incompleteChange.availableSizes[0]}”.`;
    if (incompleteChange.needsOptions) return `Which available customizations would you like for ${incompleteChange.name}? Choose from ${incompleteChange.availableOptions.join(', ') || 'none'}. For example, “${incompleteChange.availableOptions[0] || 'none'}”.`;
    return `Which required option would you like for ${incompleteChange.name}? Choose from ${incompleteChange.missingOptions.join(', ')}. For example, “${incompleteChange.missingOptions[0]}”.`;
  }

  const incompleteItems = candidates.filter(item => item.missingSize || item.missingOptions.length);
  const readyItems = candidates.filter(item => !item.missingSize && !item.missingOptions.length)
    .map(({ missingSize, missingOptions, availableSizes, ...item }) => ({ ...item, lineId: crypto.randomUUID() }));
  const updatedItems = state.items.map(item => {
    const change = changes.find(candidate => candidate.lineId === item.lineId);
    if (!change) return { ...item, options: [...item.options] };
    const { missingQuantity, missingSize, needsOptions, missingOptions, availableSizes, availableOptions, ...updatedItem } = change;
    return updatedItem;
  }).flatMap(item => {
    const removal = removals.find(candidate => candidate.lineId === item.lineId);
    if (!removal) return [item];
    return removal.action === 'remove' ? [] : [{ ...item, quantity: removal.quantity }];
  });
  const hasSameOptions = (left, right) => left.length === right.length && left.every(option => right.includes(option));
  for (const addedItem of readyItems) {
    const matchingItem = updatedItems.find(item =>
      item.menuItemId === addedItem.menuItemId &&
      item.size === addedItem.size &&
      hasSameOptions(item.options, addedItem.options) &&
      item.quantity + addedItem.quantity <= 99
    );
    if (matchingItem) matchingItem.quantity += addedItem.quantity;
    else updatedItems.push(addedItem);
  }
  state.items = updatedItems;
  state.pendingItems = incompleteItems;
  state.pendingChanges = [];
  state.pendingRemovals = [];
  state.status = incompleteItems.length ? 'awaiting_details' : state.items.length ? 'draft' : 'empty';
  state.confirmation = 'not_requested';
  refreshOrderPricing(state, menu);

  const actions = [
    readyItems.length ? `Added ${formatOrderItems(readyItems, menu.currency)}.` : '',
    changes.length ? `Updated ${formatOrderItems(changes, menu.currency)}.` : '',
    ...removals.map(item => item.action === 'remove'
      ? `Removed ${item.currentQuantity} × ${item.name}.`
      : `Reduced ${item.name} from ${item.currentQuantity} to ${item.quantity}.`),
  ].filter(Boolean);
  const missingQuestion = nextMissingOrderDetailQuestion(state);
  return [actions.join(' '), getPricingNote(state, menu.currency), missingQuestion].filter(Boolean).join(' ');
}

app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const { message, conversationHistory } = req.body ?? {};
  if (typeof message !== 'string' || message.trim() === '') {
    return res.status(400).json({ reply: 'Please enter a message in plain text. For an order, include the item and quantity, such as “2 Regular Lattes”.' });
  }
  const session = getOrderSession(req, res);
  const trimmedMessage = message.trim();
  const explicitOrderConfirmation = /^(?:yes(?:[, ]+(?:please|i confirm(?: the order)?|that'?s (?:correct|right|fine)|that is (?:correct|right|fine)|looks good|everything looks good|sounds good|go ahead|proceed))?|yeah|yep|okay|ok|sure|confirm(?: (?:(?:the|this|my) )?order)?|i confirm(?: (?:the|this|my) order)?|i approve(?: (?:the|this|my) order)?|looks good|sounds good|that'?s (?:correct|right|fine)|that is (?:correct|right|fine)|everything (?:is )?(?:correct|right|looks good)|go ahead|please proceed|proceed|place (?:the|my) order)[.!]?$/i.test(trimmedMessage);
  const explicitOrderDecline = /^(?:no(?: thanks)?|do not save|don't save|cancel(?: (?:the|my) order| order| the order confirmation| confirmation| it)?|never mind|nevermind)[.!]?$/i.test(trimmedMessage);
  const orderEditRequested = /\b(?:add|remove|delete|drop|change|update|modify|switch|correct|replace|edit|increase|decrease|reduce|instead|actually|make (?:it|that)|set (?:it|quantity)|decide|choose|size|options?|customizations?|quantity|how many)\b/i.test(trimmedMessage);
  const checkoutRequested = /\b(check[\s-]?out|place (?:my )?order|submit order|finali[sz]e order)\b/i.test(trimmedMessage) &&
    !/\b(?:change|correct|update|fix|modify|switch|instead|actually|edit|wrong)\b/i.test(trimmedMessage);
  const affirmativeAddAnother = /^(?:yes(?:,? please)?|yeah|yep|sure|okay|ok)[.!]?$/i.test(trimmedMessage);
  const declineAddAnother = /^(?:no(?:,? thanks)?|not now|that's all|that is all|nothing else|no more)[.!]?$/i.test(trimmedMessage);
  const awaitingDeliveryAddressConfirmation = session.orderState.deliveryAddress.confirmation === 'awaiting_confirmation';

  if (session.awaitingAnotherItem && !awaitingDeliveryAddressConfirmation && affirmativeAddAnother) {
    session.awaitingAnotherItem = false;
    session.pendingOrderConfirmation = null;
    session.orderState.status = 'draft';
    session.orderState.confirmation = 'not_requested';
    return res.json({
      reply: 'Sure. What would you like to add? Include the item and quantity, plus a size or available customization if needed—for example, “1 Large Latte”.',
      orderState: session.orderState,
    });
  }
  if (session.awaitingAnotherItem && !awaitingDeliveryAddressConfirmation && declineAddAnother) {
    session.awaitingAnotherItem = false;
    return res.json({
      reply: getCheckoutOrderSummary(session.orderState, session.pendingOrderConfirmation?.pricing.currency || 'PLN'),
      orderState: session.orderState,
    });
  }
  if (session.awaitingAnotherItem && (orderEditRequested || checkoutRequested)) {
    session.awaitingAnotherItem = false;
    session.pendingOrderConfirmation = null;
    session.orderState.status = session.orderState.items.length ? 'draft' : 'empty';
    session.orderState.confirmation = 'not_requested';
  }

  if (session.pendingOrderConfirmation && explicitOrderConfirmation) {
    if (session.orderSaveInProgress) {
      return res.status(409).json({ reply: 'This order confirmation is already being saved. Please wait a moment.' });
    }
    session.orderSaveInProgress = true;
    let order;
    try {
      order = createConfirmedOrderRecord(session.pendingOrderConfirmation);
      order = await appendConfirmedOrder(order);
    } catch (error) {
      session.orderSaveInProgress = false;
      console.error('CafeBot could not save the confirmed order.', {
        path: ordersPath,
        name: error?.name,
        code: error?.code,
        message: error?.message,
      });
      return res.status(500).json({
        reply: 'I could not save the confirmed order, so it has not been recorded. Please try confirming again.',
        orderState: session.orderState,
      });
    }
    session.orderSaveInProgress = false;
    session.pendingOrderConfirmation = null;
    session.orderState.status = 'confirmed';
    session.orderState.confirmation = 'order_confirmed';
    return res.json({
      reply: `Order ${order.id} was saved as confirmed in local development storage. It has not been sent to the cafe and no payment was processed.`,
      orderId: order.id,
      orderState: session.orderState,
    });
  }
  if (session.pendingOrderConfirmation && explicitOrderDecline) {
    session.pendingOrderConfirmation = null;
    session.awaitingAnotherItem = false;
    session.orderState = createEmptyOrderState();
    return res.json({
      reply: 'Your draft order has been cancelled. Nothing was saved. You can start a new order whenever you’re ready.',
      orderState: session.orderState,
    });
  }
  if (session.pendingOrderConfirmation && !checkoutRequested && !explicitOrderConfirmation &&
      !orderEditRequested) {
    return res.json({
      reply: 'The complete bill is ready. Reply “confirm order” to save it, or tell me what you would like to change.',
      orderState: session.orderState,
    });
  }
  if (
    session.pendingOrderConfirmation &&
    !checkoutRequested &&
    !explicitOrderConfirmation &&
    orderEditRequested
  ) {
    session.pendingOrderConfirmation = null;
    session.orderState.status = session.orderState.items.length ? 'draft' : 'empty';
    session.orderState.confirmation = 'not_requested';
  }

  let menu;
  let timings;
  let systemPrompt;
  let contextSource = 'menu JSON';
  try {
    const menuContents = await fsPromises.readFile(menuPath, 'utf8');
    menu = JSON.parse(menuContents);
    if (
      !menu ||
      typeof menu.currency !== 'string' ||
      !Array.isArray(menu.items) ||
      menu.items.some(item =>
        !item ||
        typeof item.category !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.description !== 'string' ||
        !Number.isFinite(item.price_pln) || item.price_pln < 0 ||
        !Array.isArray(item.sizes) || item.sizes.some(size =>
          !size || typeof size.name !== 'string' || !Number.isFinite(size.price_adjustment_pln) || size.price_adjustment_pln < 0
        ) ||
        !Array.isArray(item.options) || item.options.some(option =>
          !option || typeof option.name !== 'string' || !Number.isFinite(option.additional_price_pln) || option.additional_price_pln < 0
        ) ||
        typeof item.available !== 'boolean'
      )
    ) {
      const error = new Error('Menu JSON has an invalid structure.');
      error.code = 'INVALID_MENU_JSON';
      throw error;
    }
    refreshOrderPricing(session.orderState, menu);

    contextSource = 'opening hours JSON';
    const timingsContents = await fsPromises.readFile(timingsPath, 'utf8');
    timings = JSON.parse(timingsContents);
    const validTime = value => {
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
      return true;
    };
    if (
      !timings ||
      !Array.isArray(timings.hours) ||
      timings.hours.length === 0 ||
      timings.hours.some(entry =>
        !entry ||
        typeof entry.days !== 'string' ||
        !validTime(entry.open) ||
        !validTime(entry.close)
      )
    ) {
      const error = new Error('Opening hours JSON has an invalid structure.');
      error.code = 'INVALID_TIMINGS_JSON';
      throw error;
    }

    contextSource = 'system prompt';
    systemPrompt = await fsPromises.readFile(systemPromptPath, 'utf8');
    if (!systemPrompt.trim()) {
      const error = new Error('System prompt is empty.');
      error.code = 'EMPTY_SYSTEM_PROMPT';
      throw error;
    }
  } catch (error) {
    console.error(contextSource === 'opening hours JSON'
      ? 'CafeBot could not load its opening hours data.'
      : 'CafeBot could not load its context files.', {
      source: contextSource,
      name: error?.name,
      code: error?.code || (error instanceof SyntaxError
        ? contextSource === 'opening hours JSON' ? 'INVALID_TIMINGS_JSON' : 'INVALID_MENU_JSON'
        : undefined),
    });
    return res.status(500).json({
      reply: 'Sorry, CafeBot’s cafe information is unavailable right now. Please try again later.',
    });
  }

  if (checkoutRequested) {
    const missingDetailQuestion = nextMissingOrderDetailQuestion(session.orderState);
    if (missingDetailQuestion) return res.json({ reply: missingDetailQuestion, orderState: session.orderState });
    if (!session.orderState.items.length) {
      return res.json({ reply: 'Your order draft is empty. Add an item before checkout.', orderState: session.orderState });
    }
    session.pendingOrderConfirmation = createPendingOrderSnapshot(session.orderState, menu.currency);
    session.orderState.status = 'awaiting_confirmation';
    session.orderState.confirmation = 'awaiting';
    return res.json({ reply: getCheckoutOrderSummary(session.orderState, menu.currency), orderState: session.orderState });
  }

  if (explicitOrderConfirmation && !(session.orderState.orderType === 'delivery' && session.orderState.deliveryAddress.confirmation === 'awaiting_confirmation')) {
    const missingDetailQuestion = nextMissingOrderDetailQuestion(session.orderState);
    if (missingDetailQuestion) return res.json({ reply: missingDetailQuestion, orderState: session.orderState });
    if (!session.orderState.items.length) {
      return res.json({ reply: 'Your order draft is empty. Add an item before checkout.', orderState: session.orderState });
    }
    session.pendingOrderConfirmation = createPendingOrderSnapshot(session.orderState, menu.currency);
    session.orderState.status = 'awaiting_confirmation';
    session.orderState.confirmation = 'awaiting';
    return res.json({ reply: getCheckoutOrderSummary(session.orderState, menu.currency), orderState: session.orderState });
  }

  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'your_openai_api_key_here') {
    return res.status(503).json({
      reply: 'Sorry, CafeBot is not connected right now. Please try again later.',
    });
  }

  try {
    const history = Array.isArray(conversationHistory)
      ? conversationHistory
          .filter(item =>
            item &&
            (item.role === 'user' || item.role === 'assistant') &&
            typeof item.content === 'string'
          )
          .slice(-8)
          .map(item => ({ role: item.role, content: item.content.slice(0, 4000) }))
      : [];
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    let currentTimeContext = 'Cafe timezone is unknown or invalid. Do not determine whether the cafe is open now; explain that CafeBot cannot verify current open status without a configured timezone.';
    const timeZone = process.env.TZ?.trim();
    if (timeZone) {
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone,
          weekday: 'long',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        currentTimeContext = `Cafe timezone: ${timeZone}. Current local day and time: ${values.weekday}, ${values.hour}:${values.minute}.`;
      } catch {
        currentTimeContext = 'Cafe timezone is unknown or invalid. Do not determine whether the cafe is open now; explain that CafeBot cannot verify current open status without a configured timezone.';
      }
    }
    const response = await openai.responses.create({
      model: 'gpt-6-luna',
      instructions: `${systemPrompt.trim()}\n\nCurrent menu data (JSON):\n${JSON.stringify(menu)}\n\nCurrent opening hours data (JSON):\n${JSON.stringify(timings)}\n\nCurrent session order state (JSON):\n${JSON.stringify(session.orderState)}\n\nSet showOrderSummary true when asked what is currently in the order. Never calculate, alter, or invent order prices, subtotals, taxes, fees, or totals; the server calculates them. Return orderDetailsUpdate values only when the customer provides them; otherwise return nulls. Capture every valid order detail from the message and ask only for what remains missing. Preserve supplied details across corrections and order-type changes; pickup time is optional. Return addItems only for newly requested items, modifyItems only for requested changes to an existing lineId, and removeItems only for requested removals or reductions. When an item detail is missing, ask for it without confirming the item. Use only exact menu IDs, line IDs, sizes, and options from supplied data. Never repeat existing items as additions. The server applies validated draft changes; only the complete checkout summary needs explicit confirmation. Do not apply unverified promotions or claim the order was submitted.\n\n${currentTimeContext}`,
      input: [...history, { role: 'user', content: message.trim().slice(0, 4000) }],
      text: { format: responseFormat },
      max_output_tokens: 450,
    });

    if (!response.output_text?.trim()) {
      throw new Error('OpenAI response did not contain text.');
    }

    const result = JSON.parse(response.output_text);
    if (
      typeof result.reply !== 'string' ||
      !result.reply.trim() ||
      typeof result.showOrderSummary !== 'boolean' ||
      !result.orderDetailsUpdate ||
      !Array.isArray(result.addItems) ||
      !Array.isArray(result.modifyItems) ||
      !Array.isArray(result.removeItems)
    ) {
      throw new Error('OpenAI response did not contain the expected chat result.');
    }
    try {
      const orderDetailsUpdate = applyOrderDetailsUpdate(session.orderState, result.orderDetailsUpdate, message, conversationHistory);
      if (orderDetailsUpdate.changed) refreshOrderPricing(session.orderState, menu);
      const serverReply = updateDraftAfterRequests(session.orderState, result.addItems, result.modifyItems, result.removeItems, menu, message);
      const itemChangeRequested = result.addItems.length > 0 || result.modifyItems.length > 0 || result.removeItems.length > 0 ||
        (serverReply?.startsWith('Added ') && session.orderState.pendingItems.length === 0);
      const addedItem = result.addItems.length > 0 || serverReply?.startsWith('Added ');
      if (addedItem && result.modifyItems.length === 0 && result.removeItems.length === 0) {
        session.awaitingAnotherItem = true;
      }
      const lastAssistantMessage = getLastAssistantMessage(conversationHistory);
      const awaitingOrderDetail = /pickup, dine-in, or delivery|what name should i put|what phone number|what street address|what city|postal code|apartment, house, or unit|delivery instructions|what quantity|what size would you like|which required option|which available customizations|part of the delivery address/i.test(lastAssistantMessage);
      const awaitingAddressCorrection = session.orderState.deliveryAddress.confirmation === 'needs_correction';
      const missingDetailQuestion = orderDetailsUpdate.changed || itemChangeRequested || awaitingOrderDetail || awaitingAddressCorrection
        ? nextMissingOrderDetailQuestion(session.orderState)
        : null;
      const missingItemChangeDetail = /^(?:what quantity|what size|which available customizations|which required option)\b/i.test(serverReply || '');
      const orderTypeIntent = detectOrderTypeIntent(message);
      const orderTypeClarification = orderTypeIntent.ambiguous
        ? 'Please choose one order type: pickup, dine-in, or delivery. For example, “pickup”.'
        : !session.orderState.orderType && /pickup, dine-in, or delivery/i.test(lastAssistantMessage) && !orderTypeIntent.orderType
          ? 'I didn’t catch the order type. Please choose pickup, dine-in, or delivery.'
          : null;
      const detailIssue = orderDetailsUpdate.issue
        ? `${orderDetailsUpdate.changed ? 'I saved the other details you provided. ' : ''}${orderDetailsUpdate.issue}`
        : null;
      if ((itemChangeRequested || orderDetailsUpdate.changed) && !missingDetailQuestion && !missingItemChangeDetail && session.orderState.items.length) {
        session.pendingOrderConfirmation = createPendingOrderSnapshot(session.orderState, menu.currency);
        session.awaitingAnotherItem = (session.awaitingAnotherItem || addedItem) &&
          result.modifyItems.length === 0 && result.removeItems.length === 0;
        session.orderState.status = 'awaiting_confirmation';
        session.orderState.confirmation = 'awaiting';
        const summary = getCheckoutOrderSummary(session.orderState, menu.currency, session.awaitingAnotherItem);
        return res.json({ reply: detailIssue ? `${detailIssue}\n\n${summary}` : summary, orderState: session.orderState });
      }
      if (itemChangeRequested && !session.orderState.items.length &&
          !session.orderState.pendingItems.length && !session.orderState.pendingChanges.length) {
        session.pendingOrderConfirmation = null;
        session.awaitingAnotherItem = false;
        session.orderState.status = 'empty';
        session.orderState.confirmation = 'not_requested';
        return res.json({ reply: 'The updated draft is empty. Add an item before checkout; nothing was saved.', orderState: session.orderState });
      }
      const orderPricingRequested = /\b(?:order|draft|items?)\b.{0,30}\b(?:total|subtotal|cost|price|how much)\b|\b(?:total|subtotal)\b.{0,30}\b(?:order|draft|items?)\b|\b(?:my|the) total\b/i.test(message);
      const additionalMissingQuestion = missingDetailQuestion && !serverReply?.includes(missingDetailQuestion) ? missingDetailQuestion : null;
      const reply = orderTypeClarification || detailIssue || [serverReply, additionalMissingQuestion].filter(Boolean).join(' ') || (result.showOrderSummary
          || orderPricingRequested
          ? getCurrentOrderSummary(session.orderState, menu.currency)
          : result.reply.trim());
      return res.json({ reply, orderState: session.orderState });
    } catch (error) {
      const availableSizes = error?.message?.match(/^Available sizes for (.+): (.+)\.$/);
      const availableOptions = error?.message?.match(/^Available customizations for (.+): (.+)\.$/);
      const reply = error?.message?.startsWith('Please tell me how many ')
        ? error.message
        : availableSizes
        ? `I couldn't match that size for ${availableSizes[1]}. Available sizes are ${availableSizes[2]}. Which would you like?`
        : availableOptions
          ? `I couldn't match that customization for ${availableOptions[1]}. Available options are ${availableOptions[2]}. Which would you like?`
          : error?.message === 'Quantity must be from 1 to 99.'
            ? 'Please choose a quantity from 1 to 99.'
            : error?.message === 'Order item is not available or valid.'
              ? 'I couldn’t match that as an available menu item. Please use an available menu name with its quantity and size if needed, for example, “2 Regular Lattes”.'
              : error?.message === 'That order item was not found.'
                ? 'I couldn’t find that item in your current order. Please name an item shown in your order summary and tell me whether to change or remove it.'
                : 'I couldn’t apply that change. Please clarify the menu item and change you want—for example, “change my latte to Large” or “remove the muffin”.';
      return res.json({
        reply,
        orderState: session.orderState,
      });
    }
  } catch (error) {
    const message = typeof error?.message === 'string' ? error.message : 'Unknown OpenAI SDK error.';
    const apiKey = process.env.OPENAI_API_KEY;
    const safeMessage = (apiKey ? message.split(apiKey).join('[REDACTED]') : message)
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
    console.error('CafeBot OpenAI request failed.', {
      message: safeMessage,
      status: error?.status,
      type: error?.type,
      code: error?.code,
    });
    return res.status(502).json({
      reply: 'Sorry, I am having trouble responding right now. Please try again shortly.',
    });
  }
});

app.use(express.static(frontendPath));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  console.error('CafeBot could not process an incoming request.', {
    status,
    name: error?.name,
    code: error?.type || error?.code,
  });
  const reply = status === 413
    ? 'That request is too long. Please send a shorter message.'
    : status === 400
      ? 'I could not read that request. Please send your message as plain text and try again.'
      : status < 500
        ? 'I could not accept that request. Please send a text message and try again.'
        : 'Something went wrong while handling that request. Please try again.';
  return res.status(status).json({ reply });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`CafeBot is running at http://localhost:${port}`);
  });
}

module.exports = app;
