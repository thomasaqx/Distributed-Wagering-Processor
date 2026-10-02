import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { createOrmConfig } from "./mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => ({ ...createOrmConfig(), registerRequestContext: false }),
    }),
  ],
})
export class DatabaseModule {}
