function errorMessage(error) {
  return String(error?.message || error || '');
}

function isMissingRecipientError(error) {
  const message = errorMessage(error);
  const isBadRequest = Number(error?.status) === 400 || /\bWPPConnect respondeu 400\b/i.test(message);
  const saysNumberIsMissing = /(?:n[uú]mero|number).{0,80}(?:n[aã]o existe|does not exist|not exist|not registered)/i.test(message);
  return isBadRequest && saysNumberIsMissing;
}

function skipPreviouslyRejectedRecipients(campaign, failedRecipients) {
  if (!Array.isArray(campaign?.lanes) || !Array.isArray(campaign?.recipients)) return 0;
  const laneCount = Array.isArray(campaign.numberIds) ? campaign.numberIds.length : 0;
  if (!laneCount) return 0;

  let skipped = 0;
  campaign.lanes.forEach((lane) => {
    if (lane.done) return;
    const recipient = campaign.recipients[lane.nextIndex];
    if (!recipient) {
      lane.done = true;
      return;
    }
    const previousFailure = failedRecipients.find((failure) => (
      failure.status === 'failed'
      && failure.wppNumberId === lane.numberId
      && String(failure.phone) === String(recipient.phone)
      && isMissingRecipientError(failure.error)
    ));
    if (!previousFailure) return;

    lane.nextIndex += laneCount;
    lane.done = lane.nextIndex >= campaign.recipients.length;
    skipped += 1;
  });
  return skipped;
}

module.exports = { isMissingRecipientError, skipPreviouslyRejectedRecipients };
