"use client";

import { useEffect, useMemo, useState } from "react";
import { formatRelative } from "@/lib/format";
import type { TerminalsResponse } from "@/lib/types";
import { usePoll } from "@/lib/use-poll";
import MetricCard from "./MetricCard";
import { IconScan, IconServer, IconClock } from "./icons";

type ModalMode = "add" | "edit" | null;

interface Device {
  id: number;
  mac: string;
  ip: string;
  location: string;
  branch: string;
  status: "Online" | "Offline";
  lastPing: number | null;
  scansToday: number;
}

const BRANCHES = Array.from({ length: 17 }, (_, i) => `Branch ${i + 1}`);

function Modal({
  open,
  onClose,
  mode,
  device,
  onSubmit,
  error,
}: {
  open: boolean;
  onClose: () => void;
  mode: ModalMode;
  device?: Device;
  onSubmit: (data: any) => Promise<void> | void;
  error?: string | null;
}) {
  const [mac, setMac] = useState(device?.mac || "");
  const [ip, setIp] = useState(device?.ip || "");
  const [name, setName] = useState(device?.location || "");
  const [branch, setBranch] = useState(device?.branch || "Branch 1");
  const [status, setStatus] = useState<"Online" | "Offline">(device?.status || "Offline");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (device) {
      setMac(device.mac);
      setIp(device.ip);
      setName(device.location);
      setBranch(device.branch || "Branch 1");
      setStatus(device.status);
    } else {
      setMac("");
      setIp("");
      setName("");
      setBranch("Branch 1");
      setStatus("Offline");
    }
  }, [device, open]);

  if (!open) return null;}