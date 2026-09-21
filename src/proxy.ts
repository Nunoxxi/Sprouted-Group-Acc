import { getSessionCookie } from 'better-auth/cookies';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Optimistic redirect only: a visitor with no session cookie goes to the
 * sign-in page instead of rendering an app page that would fail anyway.
 * This proves nothing — a cookie can be stale or forged — so every page,
 * Server Function and Route Handler still verifies the session and entity
 * access through src/lib/dal.ts. That is the check; this is the courtesy.
 */

const publicPaths = ['/sign-in', '/two-factor', '/set-password', '/forgot-password'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasCookie = Boolean(getSessionCookie(request));
  const isPublic = publicPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  if (!hasCookie && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/sign-in';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Pages only. API routes answer 401 themselves (a redirect is the wrong
  // reply to a fetch), and /api/auth must stay reachable to sign in at all.
  // The field form's service worker and manifest must load without a session too.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|field-sw\\.js|manifest\\.webmanifest|.*\\.(?:png|svg|ico|jpg|webp)$).*)'],
};
