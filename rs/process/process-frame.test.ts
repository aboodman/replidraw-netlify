import { expect } from "chai";
import { test } from "mocha";
import { JSONType } from "../protocol/json";
import { WriteTransaction } from "replicache";
import { z } from "zod";
import { MemStorage } from "../storage/mem-storage";
import { ClientMutation } from "../types/client-mutation";
import { ClientPokeBody } from "../types/client-poke-body";
import { ClientRecord, clientRecordKey } from "../types/client-record";
import { ClientID } from "../types/client-state";
import { UserValue, userValueKey } from "../types/user-value";
import { Version, versionKey } from "../types/version";
import { PeekIterator } from "../util/peek-iterator";
import { clientMutation, clientRecord, userValue } from "../util/test-utils";
import { processFrame } from "./process-frame";
import { LogContext } from "../util/logger";

test("processFrame", async () => {
  const records = new Map([
    [clientRecordKey("c1"), clientRecord(null, 1)],
    [clientRecordKey("c2"), clientRecord(1, 7)],
  ]);
  const startTime = 100;
  const endTime = 200;
  const startVersion = 1;
  const endVersion = 2;

  type Case = {
    name: string;
    mutations: ClientMutation[];
    clients: ClientID[];
    expectedPokes: ClientPokeBody[];
    expectedUserValues: Map<string, UserValue>;
    expectedClientRecords: Map<string, ClientRecord>;
    expectedVersion: Version;
  };

  const mutators = new Map(
    Object.entries({
      put: async (
        tx: WriteTransaction,
        { key, value }: { key: string; value: JSONType }
      ) => {
        await tx.put(key, value);
      },
      del: async (tx: WriteTransaction, { key }: { key: string }) => {
        await tx.del(key);
      },
    })
  );

  const cases: Case[] = [
    {
      name: "no mutations, no clients",
      mutations: [],
      clients: [],
      expectedPokes: [],
      expectedUserValues: new Map(),
      expectedClientRecords: records,
      expectedVersion: startVersion,
    },
    {
      name: "no mutations, one client",
      mutations: [],
      clients: ["c1"],
      expectedPokes: [],
      expectedUserValues: new Map(),
      expectedClientRecords: records,
      expectedVersion: startVersion,
    },
    {
      name: "one mutation, one client",
      mutations: [clientMutation("c1", 2, "put", { key: "foo", value: "bar" })],
      clients: ["c1"],
      expectedPokes: [
        {
          clientID: "c1",
          poke: {
            baseCookie: startVersion,
            cookie: endVersion,
            lastMutationID: 2,
            patch: [
              {
                op: "put",
                key: "foo",
                value: "bar",
              },
            ],
            timestamp: startTime,
          },
        },
      ],
      expectedUserValues: new Map([
        [userValueKey("foo"), userValue("bar", endVersion)],
      ]),
      expectedClientRecords: new Map([
        ...records,
        [clientRecordKey("c1"), clientRecord(endVersion, 2)],
      ]),
      expectedVersion: endVersion,
    },
    {
      name: "one mutation, two clients",
      mutations: [clientMutation("c1", 2, "put", { key: "foo", value: "bar" })],
      clients: ["c1", "c2"],
      expectedPokes: [
        {
          clientID: "c1",
          poke: {
            baseCookie: startVersion,
            cookie: endVersion,
            lastMutationID: 2,
            patch: [
              {
                op: "put",
                key: "foo",
                value: "bar",
              },
            ],
            timestamp: startTime,
          },
        },
        {
          clientID: "c2",
          poke: {
            baseCookie: startVersion,
            cookie: endVersion,
            lastMutationID: 7,
            patch: [
              {
                op: "put",
                key: "foo",
                value: "bar",
              },
            ],
            timestamp: startTime,
          },
        },
      ],
      expectedUserValues: new Map([
        [userValueKey("foo"), userValue("bar", endVersion)],
      ]),
      expectedClientRecords: new Map([
        [clientRecordKey("c1"), clientRecord(endVersion, 2)],
        [clientRecordKey("c2"), clientRecord(endVersion, 7)],
      ]),
      expectedVersion: endVersion,
    },
    {
      name: "two mutations, one client, one key",
      mutations: [
        clientMutation("c1", 2, "put", { key: "foo", value: "bar" }),
        clientMutation("c1", 3, "put", { key: "foo", value: "baz" }),
      ],
      clients: ["c1"],
      expectedPokes: [
        {
          clientID: "c1",
          poke: {
            baseCookie: startVersion,
            cookie: endVersion,
            lastMutationID: 3,
            patch: [
              {
                op: "put",
                key: "foo",
                value: "baz",
              },
            ],
            timestamp: startTime,
          },
        },
      ],
      expectedUserValues: new Map([
        [userValueKey("foo"), userValue("baz", endVersion)],
      ]),
      expectedClientRecords: new Map([
        ...records,
        [clientRecordKey("c1"), clientRecord(endVersion, 3)],
      ]),
      expectedVersion: endVersion,
    },
    {
      name: "frame cutoff",
      mutations: [
        clientMutation("c1", 2, "put", { key: "foo", value: "bar" }, 50),
        clientMutation("c1", 3, "put", { key: "foo", value: "baz" }, 150),
        clientMutation("c1", 4, "put", { key: "foo", value: "bonk" }, 250),
      ],
      clients: ["c1"],
      expectedPokes: [
        {
          clientID: "c1",
          poke: {
            baseCookie: startVersion,
            cookie: endVersion,
            lastMutationID: 3,
            patch: [
              {
                op: "put",
                key: "foo",
                value: "baz",
              },
            ],
            timestamp: startTime,
          },
        },
      ],
      expectedUserValues: new Map([
        [userValueKey("foo"), userValue("baz", endVersion)],
      ]),
      expectedClientRecords: new Map([
        ...records,
        [clientRecordKey("c1"), clientRecord(endVersion, 3)],
      ]),
      expectedVersion: endVersion,
    },
  ];

  for (const c of cases) {
    const storage = new MemStorage();

    await storage.put(versionKey, startVersion);
    for (const [key, value] of records) {
      await storage.put(key, value);
    }

    const result = await processFrame(
      new LogContext("info"),
      new PeekIterator(c.mutations[Symbol.iterator]()),
      mutators,
      c.clients,
      storage,
      startTime,
      endTime
    );

    expect(result, c.name).deep.equal(c.expectedPokes);

    const expectedState = new Map([
      ...(c.expectedUserValues as Map<string, JSONType>),
      ...(c.expectedClientRecords as Map<string, JSONType>),
      [versionKey, c.expectedVersion],
    ]);
    expect(storage.size, c.name).equal(expectedState.size);
    for (const [key, value] of expectedState) {
      expect(await storage.get(key, z.any()), c.name).deep.equal(value);
    }
  }
});