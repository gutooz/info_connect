const assert = require('node:assert/strict');
const test = require('node:test');
const { isMissingRecipientError, skipPreviouslyRejectedRecipients } = require('./campaign-errors');

test('identifica a rejeição de um número inexistente sem confundir com falha de infraestrutura', () => {
  const missingNumber = new Error('WPPConnect respondeu 400: {"message":"O número 1111111111 não existe."}');
  missingNumber.status = 400;

  assert.equal(isMissingRecipientError(missingNumber), true);
  assert.equal(isMissingRecipientError(new Error('WPPConnect respondeu 502: gateway indisponível')), false);
  assert.equal(isMissingRecipientError(new Error('WPPConnect não está configurado.')), false);
});

test('retomada pula somente o destinatário inexistente que já falhou na posição atual', () => {
  const campaign = {
    numberIds: ['number-1'],
    recipients: [
      { phone: '1111111111' },
      { phone: '5511999999999' }
    ],
    lanes: [{ numberId: 'number-1', nextIndex: 0, done: false, sentSinceBreak: 7 }]
  };
  const failures = [{
    wppNumberId: 'number-1',
    phone: '1111111111',
    status: 'failed',
    error: 'WPPConnect respondeu 400: {"message":"O número 1111111111 não existe."}'
  }];

  const skipped = skipPreviouslyRejectedRecipients(campaign, failures);

  assert.equal(skipped, 1);
  assert.equal(campaign.lanes[0].nextIndex, 1);
  assert.equal(campaign.lanes[0].done, false);
  assert.equal(campaign.lanes[0].sentSinceBreak, 7);
});

test('retomada não pula destinatário quando a falha foi de infraestrutura', () => {
  const campaign = {
    numberIds: ['number-1'],
    recipients: [{ phone: '5511999999999' }],
    lanes: [{ numberId: 'number-1', nextIndex: 0, done: false, sentSinceBreak: 0 }]
  };
  const failures = [{
    wppNumberId: 'number-1',
    phone: '5511999999999',
    status: 'failed',
    error: 'WPPConnect respondeu 502: serviço indisponível'
  }];

  assert.equal(skipPreviouslyRejectedRecipients(campaign, failures), 0);
  assert.equal(campaign.lanes[0].nextIndex, 0);
});
