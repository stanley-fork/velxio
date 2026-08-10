/**
 * Product news ("What's New") — a toast, and a modal only on request.
 *
 * This used to auto-open a modal a few seconds after the editor loaded.
 * That put a passive announcement on top of whatever the user was doing,
 * and on a pristine visit it landed squarely over the starter-template
 * dialog: two stacked overlays, two dimmed backdrops, and the *less*
 * important one on top (news z-index 10000 vs starter 9000). The delay
 * made it worse, not better — it arrived after the user had begun
 * reading, which is the most disruptive moment to interrupt.
 *
 * So: a modal is for what BLOCKS, and an announcement never blocks. The
 * post now slides in as a corner toast that steals no focus and dims
 * nothing, and auto-retires. The full post is one click away — a modal
 * the user asked for is a different thing from one thrown at them — and
 * stays reachable afterwards from Help ▸ What's new.
 *
 * The queue/seen logic still lives in lib/newsSource.ts (OSS:
 * localStorage over /api/news/feed; pro: server-backed per user). The
 * fetch is delayed so it never competes with editor startup, and every
 * failure path resolves to "nothing shown".
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { getNextNews, type NewsPost } from '../../lib/newsSource';
import { NewsMarkdown } from './NewsMarkdown';
import { registerEditorCommand } from '../../lib/editorCommands';
import './NewsAnnouncer.css';

const FETCH_DELAY_MS = 4000;
/** Long enough to read a title and decide, short enough to not linger. */
const TOAST_DISMISS_MS = 14000;

export function NewsAnnouncer() {
  const { t } = useTranslation();
  const [post, setPost] = useState<NewsPost | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [toastVisible, setToastVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void getNextNews().then((p) => {
        if (cancelled || !p) return;
        setPost(p);
        setToastVisible(true);
      });
    }, FETCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  // Help ▸ What's new re-opens the last delivered post. Registered even
  // with nothing to show yet; the handler no-ops until a post arrives,
  // which keeps the menu row's enabled state honest once one has.
  useEffect(() => {
    if (!post) return;
    return registerEditorCommand('help.whatsNew', () => {
      setToastVisible(false);
      setExpanded(true);
    });
  }, [post]);

  // Auto-retire the toast. Cancelled if the user opens the full post, so
  // reading it never races with the timer.
  useEffect(() => {
    if (!toastVisible || expanded) return;
    const timer = setTimeout(() => setToastVisible(false), TOAST_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toastVisible, expanded]);

  if (!post) return null;

  if (expanded) {
    return createPortal(
      <div className="velxio-news-overlay" onClick={() => setExpanded(false)}>
        <div
          className="velxio-news-modal"
          role="dialog"
          aria-modal="true"
          aria-label={post.title}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="velxio-news-header">
            <div>
              <span className="velxio-news-kicker">
                {t('news.kicker', "What's new")}
              </span>
              <h2 className="velxio-news-title">{post.title}</h2>
            </div>
            <button
              className="velxio-news-close"
              aria-label={t('news.close', 'Close')}
              onClick={() => setExpanded(false)}
            >
              ×
            </button>
          </div>
          <div className="velxio-news-body">
            <NewsMarkdown>{post.body_md}</NewsMarkdown>
          </div>
          <div className="velxio-news-footer">
            <button className="velxio-news-ok" onClick={() => setExpanded(false)}>
              {t('news.gotIt', 'Got it')}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  if (!toastVisible) return null;

  return createPortal(
    // role="status" (not "alert"): polite, so a screen reader finishes the
    // current utterance instead of cutting the user off — the accessible
    // equivalent of not stealing focus.
    <div className="velxio-news-toast" role="status" aria-live="polite">
      <div className="velxio-news-toast-head">
        <span className="velxio-news-kicker">{t('news.kicker', "What's new")}</span>
        <button
          className="velxio-news-toast-close"
          aria-label={t('news.close', 'Close')}
          onClick={() => setToastVisible(false)}
        >
          ×
        </button>
      </div>
      <div className="velxio-news-toast-title">{post.title}</div>
      <button
        className="velxio-news-toast-more"
        onClick={() => {
          setExpanded(true);
        }}
      >
        {t('news.readMore', 'Read more')} →
      </button>
    </div>,
    document.body,
  );
}
