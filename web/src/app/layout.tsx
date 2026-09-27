import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "Reserva — Event Management & Ticketing Platform",
  description:
    "The Reserva event-ticketing API: events, ticket tiers, registrations, Flutterwave payments, staff check-in, attendee requests, and an organiser dashboard.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
