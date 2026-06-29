export interface NotificationMetaLike {
  category: string;
  resource_type?: string | null;
  link?: string | null;
}

function linkHasTagParam(link: string | null | undefined): boolean {
  if (!link) return false;

  try {
    return new URL(link, 'http://looplet.local').searchParams.has('tag');
  } catch {
    return /(?:[?&])tag=/.test(link);
  }
}

export function isTagMentionNotification(notification: NotificationMetaLike): boolean {
  return (
    notification.category === 'mention' ||
    notification.resource_type === 'tag' ||
    linkHasTagParam(notification.link)
  );
}
