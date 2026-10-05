import { NextResponse } from 'next/server';
import { renderToBuffer } from '@react-pdf/renderer';
import React from 'react';
import { db } from '@/lib/db';
import { NdaPdfDocument } from '@/components/pdf/NdaPdfDocument';
import { getExpressSessionUser } from '@/lib/server-session';

export async function GET(req: Request) {
  try {
    const sessionUser = await getExpressSessionUser(req);
    if (!sessionUser) {
      return NextResponse.json(
        { error: 'Unauthorized: Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(req.url);
    const targetUserId = searchParams.get('userId');

    if (!targetUserId) {
      return NextResponse.json({ error: 'Missing userId parameter' }, { status: 400 });
    }

    const isOwner = String(sessionUser.id) === String(targetUserId);
    const isAdmin = Boolean(sessionUser.is_admin || sessionUser.is_creator);

    if (!isOwner && !isAdmin) {
      return NextResponse.json(
        { error: 'Forbidden: Access denied to requested NDA record' },
        { status: 403 }
      );
    }

    const user = await db.user.findUnique({
      where: { id: targetUserId },
      select: {
        id: true,
        fullName: true,
        email: true,
        ndaSigned: true,
        ndaSignedAt: true,
        ndaSignedIp: true,
        ndaUserAgent: true,
        ndaVersion: true,
        ndaTypedSignature: true
      }
    });

    if (!user || !user.ndaSigned) {
      return NextResponse.json(
        { error: 'NOT_FOUND', message: 'No signed NDA record found for this user.' },
        { status: 404 }
      );
    }

    const auditData = {
      userId: user.id,
      fullName: user.fullName,
      email: user.email,
      typedSignature: user.ndaTypedSignature || user.fullName,
      signedAt: user.ndaSignedAt || new Date(),
      ipAddress: user.ndaSignedIp || '0.0.0.0',
      userAgent: user.ndaUserAgent || 'UNKNOWN',
      version: user.ndaVersion || 'v1.0-BETA'
    };

    const pdfBuffer = await renderToBuffer(
      React.createElement(NdaPdfDocument, { data: auditData }) as any
    );

    const safeName = (user.fullName || 'FACTS_User').replace(/\s+/g, '_');

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="Signed_NDA_${safeName}.pdf"`,
        'Cache-Control': 'no-store, max-age=0'
      }
    });
  } catch (error) {
    console.error('Failed to generate NDA PDF:', error);
    return NextResponse.json({ error: 'SERVER_ERROR' }, { status: 500 });
  }
}
