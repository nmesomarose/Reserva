/**
 * Composition root.
 *
 * The one place where the domain services are wired to their real collaborators.
 * Keeping construction here is what allows the domain and the route handlers to
 * depend on interfaces: tests replace this module (via `vi.mock`) or construct a
 * service directly with a fake repository.
 *
 * Every service is memoised so a request that resolves an organiser identity and
 * then lists events builds one repository, not two, and so the Prisma client is
 * reached through a single accessor.
 *
 * The registration and payment services are memoised **together on one repository
 * instance**. That is not a micro-optimisation: they must agree about the same rows,
 * and two instances would still be correct (they are stateless) — but sharing one
 * keeps the wiring readable as "the registration slice owns this repository" instead
 * of leaving a reader to work out which of two identical objects each service got.
 */

import "server-only";

import { EventService } from "@/domain/events/event.service";
import { TicketTypeService } from "@/domain/tickets/ticket-type.service";
import { OperationsService } from "@/domain/operations/operations.service";
import { PaymentService } from "@/domain/registrations/payment.service";
import { EvidenceService } from "@/domain/registrations/evidence.service";
import { RegistrationService } from "@/domain/registrations/registration.service";
import { RequestService } from "@/domain/requests/request.service";
import { StaffService } from "@/domain/staff/staff.service";

import { AuthService } from "../auth/auth.service";
import { getPaymentEnv } from "../env";
import { FlutterwaveClient } from "../flutterwave/client";
import { buildVerifyRedirectUrl } from "../flutterwave/redirect-url";
import { NodeStaffTokenIssuer } from "../staff/staff-token";

import { PrismaAuthRepository } from "./auth.repository";
import { prisma } from "./client";
import { PrismaEventRepository } from "./event.repository";
import { PrismaEventOperationsRepository } from "./operations.repository";
import { PrismaRegistrationRepository } from "./registration.repository";
import { PrismaAttendeeRequestRepository } from "./request.repository";
import { PrismaStaffRepository } from "./staff.repository";
import { PrismaTicketTypeRepository } from "./ticket-type.repository";

let eventService: EventService | undefined;
let ticketTypeService: TicketTypeService | undefined;
let authService: AuthService | undefined;
let registrationService: RegistrationService | undefined;
let paymentService: PaymentService | undefined;
let staffService: StaffService | undefined;
let evidenceService: EvidenceService | undefined;
let requestService: RequestService | undefined;
let operationsService: OperationsService | undefined;
/** One adapter for the whole registration slice — see {@link registrations}. */
let sharedRegistrations: PrismaRegistrationRepository | undefined;

export function getEventService(): EventService {
  eventService ??= new EventService(new PrismaEventRepository(prisma));

  return eventService;
}

/**
 * Ticket tiers.
 *
 * The event repository is injected as well as the tier repository, because every
 * tier operation has to verify ownership of the *parent event* first (rule 05) and
 * that read must come from the event side of the schema. Sharing one
 * `PrismaEventRepository` instance also means a request that lists tiers and then
 * patches one reaches a single pool-backed handle.
 */
export function getTicketTypeService(): TicketTypeService {
  ticketTypeService ??= new TicketTypeService(
    new PrismaEventRepository(prisma),
    new PrismaTicketTypeRepository(prisma),
  );

  return ticketTypeService;
}

/**
 * Imported by `src/server/auth/organiser-context.ts` to resolve a session.
 *
 * That module is the auth boundary and must not construct its own repository, or
 * a test that mocks the container would get a different wiring than production.
 */
export function getAuthService(): AuthService {
  authService ??= new AuthService(new PrismaAuthRepository(prisma));

  return authService;
}

/**
 * One registration repository for the whole slice.
 *
 * Shared by the registration and payment services deliberately — see the module
 * header. Memoised so a create-then-verify request does not build two adapters over
 * two pool handles.
 */
function registrations(): PrismaRegistrationRepository {
  return (sharedRegistrations ??= new PrismaRegistrationRepository(prisma));
}

/**
 * The payment provider adapter.
 *
 * Config is read at *call* time, not at module load, so importing this file does not
 * require payment secrets to exist. That matters for the tests that mock the
 * container: they import the module and never ask for a provider, and a module-load
 * read would make every one of them depend on an unrelated integration's
 * credentials.
 */
export function getPaymentProvider(): FlutterwaveClient {
  const env = getPaymentEnv();

  return new FlutterwaveClient({
    secretKey: env.FLUTTERWAVE_SECRET_KEY,
    baseUrl: env.FLUTTERWAVE_API_BASE_URL,
  });
}

/**
 * `POST /events/{id}/registrations` and `POST /payments/initiate`.
 *
 * Needs the event repository (to re-check that the event is still `published` and not
 * soft-deleted at purchase time) and the tier repository (for the tier's stored
 * price, FR-11).
 *
 * `redirectUrl` is derived from the configured public origin by
 * `buildVerifyRedirectUrl`, so the environment holds "where this deployment lives" and
 * the path PRD §12 fixes stays owned by the code. It is `null` when no public origin
 * is configured: the payment then completes by webhook alone, which §8.6 makes the
 * governing channel.
 */
export function getRegistrationService(): RegistrationService {
  registrationService ??= new RegistrationService(
    new PrismaEventRepository(prisma),
    new PrismaTicketTypeRepository(prisma),
    registrations(),
    getPaymentProvider(),
    { redirectUrl: buildVerifyRedirectUrl(getPaymentEnv().FLUTTERWAVE_REDIRECT_BASE_URL) },
  );

  return registrationService;
}

/**
 * `POST /payments/verify` and `POST /payments/webhook`.
 *
 * The same registration repository as the registration service, so the two entry
 * channels into §8.5 cannot end up pointed at different adapters.
 */
export function getPaymentService(): PaymentService {
  paymentService ??= new PaymentService(registrations(), getPaymentProvider());

  return paymentService;
}

/**
 * The staff slice: organiser-side token lifecycle plus the two staff capabilities.
 *
 * Three collaborators, and the third is the interesting one. `NodeStaffTokenIssuer`
 * is the only path to `node:crypto` for staff access, and it is injected rather than
 * imported so the domain never reaches for a runtime primitive — the same reasoning
 * as the payment provider, which is injected for the same reason (see
 * `getPaymentProvider`).
 *
 * One repository instance shared by both halves of the slice, for the same reason
 * the registration slice shares one: the organiser mints a token and a staff member
 * spends it, and those two paths must agree about the same rows.
 */
export function getStaffService(): StaffService {
  staffService ??= new StaffService(
    new PrismaEventRepository(prisma),
    new PrismaStaffRepository(prisma),
    new NodeStaffTokenIssuer(),
  );

  return staffService;
}

/**
 * `GET /api/v1/registrations/evidence` (FR-15).
 *
 * Takes the event repository as well as the registration one, because the ticket an
 * attendee downloads carries the event's **live** details (BR-6) — an event rescheduled
 * after issue must reach the already-issued ticket, which rules out a snapshot on the
 * registration and requires the second read.
 *
 * Shares the one registration adapter with the registration and payment services, so
 * the three entry points into §8.5 and the evidence lookup cannot end up reading
 * through different mappings.
 */
export function getEvidenceService(): EvidenceService {
  evidenceService ??= new EvidenceService(registrations(), new PrismaEventRepository(prisma));

  return evidenceService;
}

/**
 * The attendee-request slice: submission (§12 row 11) and the organiser queue and
 * response (§12 row 12, R-5 G-3).
 *
 * The event repository is injected because both organiser operations must verify
 * ownership of the *parent event* before reading or writing anything (rule 05), and that
 * read comes from the event side of the schema — the same arrangement as
 * `getTicketTypeService`.
 */
export function getRequestService(): RequestService {
  requestService ??= new RequestService(
    new PrismaEventRepository(prisma),
    registrations(),
    new PrismaAttendeeRequestRepository(prisma),
  );

  return requestService;
}

/**
 * `GET /api/v1/events/{id}/dashboard` (FR-25) and `/registrations/{id}` (FR-26, R-5 G-1).
 *
 * The event repository is injected so both entry points check ownership before the
 * operations adapter is touched, and the adapter is shared with the SSE stream's
 * per-tick reads (G-2) so a dashboard's initial snapshot and its stream updates come
 * from the same mappings and the same aggregate arithmetic.
 */
export function getOperationsService(): OperationsService {
  operationsService ??= new OperationsService(
    new PrismaEventRepository(prisma),
    new PrismaEventOperationsRepository(prisma),
  );

  return operationsService;
}
