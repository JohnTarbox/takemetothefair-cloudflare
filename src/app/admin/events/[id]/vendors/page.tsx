"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { ArrowLeft, Plus, Store, Trash2, CheckCircle, XCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const runtime = "edge";

interface Vendor {
  id: string;
  businessName: string;
  slug: string;
  vendorType: string | null;
  logoUrl: string | null;
  commercial: boolean;
}

interface EventVendor {
  id: string;
  eventId: string;
  vendorId: string;
  status: string;
  boothInfo: string | null;
  vendor: Vendor;
}

interface Event {
  id: string;
  name: string;
  commercialVendorsAllowed: boolean;
}

export default function ManageEventVendorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [event, setEvent] = useState<Event | null>(null);
  const [eventVendors, setEventVendors] = useState<EventVendor[]>([]);
  const [allVendors, setAllVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedVendorId, setSelectedVendorId] = useState("");
  const [boothInfo, setBoothInfo] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetchData();
  }, [id]);

  const fetchData = async () => {
    try {
      const [eventRes, vendorsRes, allVendorsRes] = await Promise.all([
        fetch(`/api/admin/events/${id}`),
        fetch(`/api/admin/events/${id}/vendors`),
        fetch("/api/admin/vendors"),
      ]);

      if (!eventRes.ok) throw new Error("Event not found");

      const eventData = await eventRes.json() as Event;
      const vendorsData = await vendorsRes.json() as EventVendor[];
      const allVendorsData = await allVendorsRes.json() as Vendor[];

      setEvent(eventData);
      setEventVendors(vendorsData);
      setAllVendors(allVendorsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  const handleAddVendor = async () => {
    if (!selectedVendorId) return;

    setAdding(true);
    setError("");

    try {
      const res = await fetch(`/api/admin/events/${id}/vendors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: selectedVendorId,
          status: "APPROVED",
          boothInfo: boothInfo || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || "Failed to add vendor");
      }

      const newEventVendor = await res.json() as EventVendor;
      setEventVendors([...eventVendors, newEventVendor]);
      setShowAddForm(false);
      setSelectedVendorId("");
      setBoothInfo("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add vendor");
    } finally {
      setAdding(false);
    }
  };

  const handleUpdateStatus = async (eventVendorId: string, status: string) => {
    try {
      const res = await fetch(`/api/admin/events/${id}/vendors`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventVendorId, status }),
      });

      if (!res.ok) throw new Error("Failed to update status");

      setEventVendors(eventVendors.map((ev) =>
        ev.id === eventVendorId ? { ...ev, status } : ev
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update status");
    }
  };

  const handleRemoveVendor = async (eventVendorId: string) => {
    if (!confirm("Are you sure you want to remove this vendor from the event?")) return;

    try {
      const res = await fetch(`/api/admin/events/${id}/vendors?eventVendorId=${eventVendorId}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to remove vendor");

      setEventVendors(eventVendors.filter((ev) => ev.id !== eventVendorId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove vendor");
    }
  };

  // Filter out vendors already added to the event
  const availableVendors = allVendors.filter(
    (v) => !eventVendors.some((ev) => ev.vendorId === v.id)
  );

  const statusColors: Record<string, "success" | "warning" | "danger"> = {
    APPROVED: "success",
    PENDING: "warning",
    REJECTED: "danger",
  };

  const statusIcons: Record<string, typeof CheckCircle> = {
    APPROVED: CheckCircle,
    PENDING: Clock,
    REJECTED: XCircle,
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-gray-200 rounded w-1/4"></div>
        <div className="h-64 bg-gray-200 rounded"></div>
      </div>
    );
  }

  if (!event) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-600">Event not found</p>
        <Link href="/admin/events" className="text-blue-600 hover:underline mt-2 inline-block">
          Back to Events
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/admin/events"
          className="inline-flex items-center text-sm text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Events
        </Link>
      </div>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Manage Vendors</h1>
          <p className="text-gray-600 mt-1">{event.name}</p>
          {!event.commercialVendorsAllowed && (
            <Badge variant="warning" className="mt-2">Commercial vendors not allowed</Badge>
          )}
        </div>
        <Button onClick={() => setShowAddForm(true)} disabled={showAddForm}>
          <Plus className="w-4 h-4 mr-2" />
          Add Vendor
        </Button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 text-red-600 rounded-md text-sm">
          {error}
        </div>
      )}

      {showAddForm && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Add Vendor to Event</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <Label htmlFor="vendorId">Select Vendor *</Label>
                <select
                  id="vendorId"
                  value={selectedVendorId}
                  onChange={(e) => setSelectedVendorId(e.target.value)}
                  className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">Choose a vendor...</option>
                  {availableVendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.businessName}
                      {vendor.vendorType ? ` (${vendor.vendorType})` : ""}
                      {vendor.commercial ? " - Commercial" : ""}
                    </option>
                  ))}
                </select>
                {availableVendors.length === 0 && (
                  <p className="text-sm text-gray-500 mt-1">All vendors have been added to this event</p>
                )}
              </div>

              <div>
                <Label htmlFor="boothInfo">Booth Info (optional)</Label>
                <Input
                  id="boothInfo"
                  value={boothInfo}
                  onChange={(e) => setBoothInfo(e.target.value)}
                  placeholder="e.g., Booth #12, Section A"
                />
              </div>

              <div className="flex gap-2">
                <Button onClick={handleAddVendor} disabled={!selectedVendorId || adding}>
                  {adding ? "Adding..." : "Add Vendor"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowAddForm(false);
                    setSelectedVendorId("");
                    setBoothInfo("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Event Vendors ({eventVendors.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {eventVendors.length === 0 ? (
            <div className="text-center py-8">
              <Store className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-500">No vendors added to this event yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {eventVendors.map((ev) => {
                const StatusIcon = statusIcons[ev.status] || Clock;
                return (
                  <div
                    key={ev.id}
                    className="flex items-center justify-between p-4 border rounded-lg"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center">
                        {ev.vendor.logoUrl ? (
                          <img
                            src={ev.vendor.logoUrl}
                            alt={ev.vendor.businessName}
                            className="w-12 h-12 rounded-lg object-cover"
                          />
                        ) : (
                          <Store className="w-6 h-6 text-gray-400" />
                        )}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/admin/vendors/${ev.vendor.id}/edit`}
                            className="font-medium text-gray-900 hover:text-blue-600"
                          >
                            {ev.vendor.businessName}
                          </Link>
                          {ev.vendor.commercial && (
                            <Badge variant="default">Commercial</Badge>
                          )}
                        </div>
                        {ev.vendor.vendorType && (
                          <p className="text-sm text-gray-500">{ev.vendor.vendorType}</p>
                        )}
                        {ev.boothInfo && (
                          <p className="text-sm text-gray-500">Booth: {ev.boothInfo}</p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <select
                        value={ev.status}
                        onChange={(e) => handleUpdateStatus(ev.id, e.target.value)}
                        className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                      >
                        <option value="PENDING">Pending</option>
                        <option value="APPROVED">Approved</option>
                        <option value="REJECTED">Rejected</option>
                      </select>
                      <Badge variant={statusColors[ev.status]}>
                        <StatusIcon className="w-3 h-3 mr-1" />
                        {ev.status}
                      </Badge>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemoveVendor(ev.id)}
                        className="text-red-600 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
