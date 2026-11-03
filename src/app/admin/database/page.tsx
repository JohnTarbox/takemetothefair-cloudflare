"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Database,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Table,
  HardDrive,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface TableStats {
  name: string;
  rowCount: number;
}

interface DbStats {
  tables: TableStats[];
  summary: {
    tableCount: number;
    totalRows: number;
    indexCount: number;
  };
}

export default function DatabaseManagementPage() {
  const [stats, setStats] = useState<DbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/database/stats");
      if (!res.ok) throw new Error("Failed to fetch stats");
      const data: DbStats = await res.json();
      setStats(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load database stats");
    } finally {
      setLoading(false);
    }
  };

  const handleBackup = async () => {
    setBackingUp(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch("/api/admin/database/backup");
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Backup failed");
      }

      // Get filename from Content-Disposition header
      const disposition = res.headers.get("Content-Disposition");
      const filenameMatch = disposition?.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "backup.sql";

      // Download the file
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSuccess(`Backup downloaded: ${filename}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Admin
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Database className="w-6 h-6" />
            Database Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Download a read-only backup and view table statistics
          </p>
        </div>
        <Button variant="outline" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 p-3 bg-green-50 text-green-600 rounded-md text-sm flex items-center gap-2">
          <CheckCircle className="w-4 h-4" />
          {success}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Backup Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Download className="w-5 h-5 text-royal" />
              Backup Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Download a complete backup of your database as a SQL file. This includes all tables,
              data, and indexes.
            </p>
            <Button onClick={handleBackup} disabled={backingUp} className="w-full">
              {backingUp ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Creating Backup...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4 mr-2" />
                  Download Backup
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* Recovery note (OPE-1367): the in-app restore was retired. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-600" />
              Restoring the Database
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              There is no in-app restore. Recovery uses D1 Time Travel from the command line, within
              a 30-day window:{" "}
              <code className="bg-muted px-1 rounded">wrangler d1 time-travel restore</code>. See{" "}
              <code className="bg-muted px-1 rounded">docs/d1-restore-procedure.md</code>.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Database Stats */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="w-5 h-5 text-muted-foreground" />
            Database Statistics
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="animate-pulse space-y-3">
              <div className="h-4 bg-muted rounded w-1/4"></div>
              <div className="h-32 bg-muted rounded"></div>
            </div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="bg-muted p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-foreground">{stats.summary.tableCount}</p>
                  <p className="text-sm text-muted-foreground">Tables</p>
                </div>
                <div className="bg-muted p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-foreground">
                    {stats.summary.totalRows.toLocaleString()}
                  </p>
                  <p className="text-sm text-muted-foreground">Total Rows</p>
                </div>
                <div className="bg-muted p-4 rounded-lg text-center">
                  <p className="text-2xl font-bold text-foreground">{stats.summary.indexCount}</p>
                  <p className="text-sm text-muted-foreground">Indexes</p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-border">
                  <thead className="bg-muted">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        <Table className="w-4 h-4 inline mr-1" />
                        Table Name
                      </th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider">
                        Rows
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-card divide-y divide-border">
                    {stats.tables.map((table) => (
                      <tr key={table.name} className="hover:bg-muted">
                        <td className="px-4 py-3 text-sm font-mono text-foreground">
                          {table.name}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground text-right">
                          {table.rowCount >= 0 ? table.rowCount.toLocaleString() : "Error"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">Failed to load statistics</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
