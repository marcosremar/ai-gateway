/**
 * Mock for @prisma/client — used in tests since @prisma/client has no
 * hard dependency in this package (it's a host-app concern).
 */
export class PrismaClient {
  $disconnect = async () => {};
  $connect = async () => {};
}
