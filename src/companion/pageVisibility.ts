type DocumentLike = {
  visibilityState?: string;
};

export function isCompanionPageVisible(documentLike?: DocumentLike | null): boolean {
  if (!documentLike || typeof documentLike.visibilityState !== 'string') {
    return true;
  }

  return documentLike.visibilityState === 'visible';
}
