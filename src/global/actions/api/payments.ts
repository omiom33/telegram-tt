import { addActionHandler, getGlobal, setGlobal } from '../../index';

import { PaymentStep } from '../../../types';
import type { ApiChat, ApiRequestInputInvoice } from '../../../api/types';

import {
  selectPaymentRequestId,
  selectProviderPublishableKey,
  selectStripeCredentials,
  selectChatMessage,
  selectChat,
  selectPaymentFormId,
  selectProviderPublicToken,
  selectSmartGlocalCredentials,
  selectPaymentInputInvoice,
} from '../../selectors';
import { callApi } from '../../../api/gramjs';
import { getStripeError } from '../../helpers';
import { buildQueryString } from '../../../util/requestQuery';
import { DEBUG_PAYMENT_SMART_GLOCAL } from '../../../config';

import {
  updateShippingOptions,
  setPaymentStep,
  setRequestInfoId,
  setPaymentForm,
  setStripeCardInfo,
  setReceipt,
  clearPayment,
  closeInvoice,
  setSmartGlocalCardInfo, addUsers, setInvoiceInfo,
} from '../../reducers';
import { buildCollectionByKey } from '../../../util/iteratees';

addActionHandler('validateRequestedInfo', (global, actions, payload) => {
  const { requestInfo, saveInfo } = payload;
  const inputInvoice = selectPaymentInputInvoice(global);
  if (!inputInvoice) return;
  if ('slug' in inputInvoice) {
    void validateRequestedInfo(inputInvoice, requestInfo, saveInfo);
  } else {
    const chat = selectChat(global, inputInvoice.chatId);
    if (!chat) return;
    void validateRequestedInfo({
      chat,
      messageId: inputInvoice.messageId,
    }, requestInfo, saveInfo);
  }
});

async function validateRequestedInfo(inputInvoice: ApiRequestInputInvoice, requestInfo: any, shouldSave?: true) {
  const result = await callApi('validateRequestedInfo', {
    inputInvoice, requestInfo, shouldSave,
  });
  if (!result) {
    return;
  }

  const { id, shippingOptions } = result;
  if (!id) {
    return;
  }

  let global = setRequestInfoId(getGlobal(), id);
  if (shippingOptions) {
    global = updateShippingOptions(global, shippingOptions);
    global = setPaymentStep(global, PaymentStep.Shipping);
  } else {
    global = setPaymentStep(global, PaymentStep.PaymentInfo);
  }
  setGlobal(global);
}

addActionHandler('openInvoice', async (global, actions, payload) => {
  let invoice;
  if ('slug' in payload) {
    invoice = await getPaymentForm({ slug: payload.slug });
  } else {
    const chat = selectChat(global, payload.chatId);
    if (!chat) return;
    invoice = await getPaymentForm({
      chat,
      messageId: payload.messageId,
    });
  }
  if (!invoice) return;

  global = getGlobal();
  global = setInvoiceInfo(global, invoice);
  setGlobal({
    ...global,
    payment: {
      ...global.payment,
      inputInvoice: payload,
      isPaymentModalOpen: true,
      status: 'cancelled',
    },
  });
});

async function getPaymentForm(inputInvoice: ApiRequestInputInvoice) {
  const result = await callApi('getPaymentForm', inputInvoice);
  if (!result) {
    return undefined;
  }
  const { form, invoice } = result;
  let global = setPaymentForm(getGlobal(), form);
  let step = PaymentStep.PaymentInfo;
  const {
    shippingAddressRequested, nameRequested, phoneRequested, emailRequested,
  } = global.payment.invoice || {};
  if (shippingAddressRequested || nameRequested || phoneRequested || emailRequested) {
    step = PaymentStep.ShippingInfo;
  }
  global = setPaymentStep(global, step);
  setGlobal(global);
  return invoice;
}

addActionHandler('getReceipt', (global, actions, payload) => {
  const { receiptMessageId, chatId, messageId } = payload;
  const chat = chatId && selectChat(global, chatId);
  if (!messageId || !receiptMessageId || !chat) {
    return;
  }

  void getReceipt(chat, messageId, receiptMessageId);
});

async function getReceipt(chat: ApiChat, messageId: number, receiptMessageId: number) {
  const result = await callApi('getReceipt', chat, receiptMessageId);
  if (!result) {
    return;
  }

  let global = getGlobal();
  const message = selectChatMessage(global, chat.id, messageId);
  global = setReceipt(global, result, message);
  setGlobal(global);
}

addActionHandler('clearPaymentError', (global) => {
  setGlobal({
    ...global,
    payment: {
      ...global.payment,
      error: undefined,
    },
  });
});

addActionHandler('clearReceipt', (global) => {
  setGlobal({
    ...global,
    payment: {
      ...global.payment,
      receipt: undefined,
    },
  });
});

addActionHandler('sendCredentialsInfo', (global, actions, payload) => {
  const { nativeProvider } = global.payment;
  const { credentials } = payload;
  const { data } = credentials;

  if (nativeProvider === 'stripe') {
    const publishableKey = selectProviderPublishableKey(global);
    if (!publishableKey) {
      return;
    }
    void sendStripeCredentials(data, publishableKey);
  } else if (nativeProvider === 'smartglocal') {
    const publicToken = selectProviderPublicToken(global);
    if (!publicToken) {
      return;
    }
    void sendSmartGlocalCredentials(data, publicToken);
  }
});

addActionHandler('sendPaymentForm', (global, actions, payload) => {
  const { shippingOptionId, saveCredentials } = payload;
  const inputInvoice = selectPaymentInputInvoice(global);
  const formId = selectPaymentFormId(global);
  const requestInfoId = selectPaymentRequestId(global);
  const { nativeProvider } = global.payment;
  const publishableKey = nativeProvider === 'stripe'
    ? selectProviderPublishableKey(global) : selectProviderPublicToken(global);

  if (!inputInvoice || !publishableKey || !formId || !nativeProvider) {
    return undefined;
  }

  let requestInputInvoice;
  if ('slug' in inputInvoice) {
    requestInputInvoice = {
      slug: inputInvoice.slug,
    };
  } else {
    const chat = selectChat(global, inputInvoice.chatId);
    if (!chat) {
      return undefined;
    }

    requestInputInvoice = {
      chat,
      messageId: inputInvoice.messageId,
    };
  }

  void sendPaymentForm(requestInputInvoice, formId, {
    save: saveCredentials,
    data: nativeProvider === 'stripe' ? selectStripeCredentials(global) : selectSmartGlocalCredentials(global),
  }, requestInfoId, shippingOptionId);

  return {
    ...global,
    payment: {
      ...global.payment,
      status: 'pending',
    },
  };
});

async function sendStripeCredentials(
  data: {
    cardNumber: string;
    cardholder?: string;
    expiryMonth: string;
    expiryYear: string;
    cvv: string;
    country: string;
    zip: string;
  },
  publishableKey: string,
) {
  const query = buildQueryString({
    'card[number]': data.cardNumber,
    'card[exp_month]': data.expiryMonth,
    'card[exp_year]': data.expiryYear,
    'card[cvc]': data.cvv,
    'card[address_zip]': data.zip,
    'card[address_country]': data.country,
  });

  const response = await fetch(`https://api.stripe.com/v1/tokens${query}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${publishableKey}`,
    },
  });
  const result = await response.json();
  if (result.error) {
    const error = getStripeError(result.error);
    const global = getGlobal();
    setGlobal({
      ...global,
      payment: {
        ...global.payment,
        status: 'failed',
        error: {
          ...error,
        },
      },
    });
    return;
  }
  let global = setStripeCardInfo(getGlobal(), {
    type: result.type,
    id: result.id,
  });
  global = setPaymentStep(global, PaymentStep.Checkout);
  setGlobal(global);
}

async function sendSmartGlocalCredentials(
  data: {
    cardNumber: string;
    cardholder?: string;
    expiryMonth: string;
    expiryYear: string;
    cvv: string;
  },
  publicToken: string,
) {
  const params = {
    card: {
      number: data.cardNumber.replace(/[^\d]+/g, ''),
      expiration_month: data.expiryMonth,
      expiration_year: data.expiryYear,
      security_code: data.cvv.replace(/[^\d]+/g, ''),
    },
  };
  const url = DEBUG_PAYMENT_SMART_GLOCAL
    ? 'https://tgb-playground.smart-glocal.com/cds/v1/tokenize/card'
    : 'https://tgb.smart-glocal.com/cds/v1/tokenize/card';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-PUBLIC-TOKEN': publicToken,
    },
    body: JSON.stringify(params),
  });
  const result = await response.json();

  if (result.status !== 'ok') {
    // TODO после получения документации сделать аналог getStripeError(result.error);
    const error = { description: 'payment error' };
    const global = getGlobal();
    setGlobal({
      ...global,
      payment: {
        ...global.payment,
        status: 'failed',
        error: {
          ...error,
        },
      },
    });
    return;
  }

  let global = setSmartGlocalCardInfo(getGlobal(), {
    type: 'card',
    token: result.data.token,
  });
  global = setPaymentStep(global, PaymentStep.Checkout);
  setGlobal(global);
}

async function sendPaymentForm(
  inputInvoice: ApiRequestInputInvoice,
  formId: string,
  credentials: any,
  requestedInfoId?: string,
  shippingOptionId?: string,
) {
  const result = await callApi('sendPaymentForm', {
    inputInvoice, formId, credentials, requestedInfoId, shippingOptionId,
  });

  if (result === true) {
    let global = clearPayment(getGlobal());
    global = {
      ...global,
      payment: {
        ...global.payment,
        status: 'paid',
      },
    };
    setGlobal(closeInvoice(global));
  }
}

addActionHandler('setPaymentStep', (global, actions, payload = {}) => {
  return setPaymentStep(global, payload.step || PaymentStep.ShippingInfo);
});

addActionHandler('closePremiumModal', (global, actions, payload) => {
  if (!global.premiumModal) return undefined;
  const { isClosed } = payload || {};
  return {
    ...global,
    premiumModal: {
      ...global.premiumModal,
      ...(isClosed && { isOpen: false }),
      isClosing: !isClosed,
    },
  };
});

addActionHandler('openPremiumModal', async (global, actions, payload) => {
  const { initialSection, fromUserId, isSuccess } = payload || {};

  actions.loadPremiumStickers();

  const result = await callApi('fetchPremiumPromo');
  if (!result) return;

  global = getGlobal();
  global = addUsers(global, buildCollectionByKey(result.users, 'id'));

  setGlobal({
    ...global,
    premiumModal: {
      promo: result.promo,
      initialSection,
      isOpen: true,
      fromUserId,
      isSuccess,
    },
  });
});
